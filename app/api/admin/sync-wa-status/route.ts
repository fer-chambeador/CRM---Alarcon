import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/admin/sync-wa-status
 *
 * Sync masivo de status de leads del CRM con etiquetas de WhatsApp.
 *
 * Hace 2 cosas:
 *   1. Repara el CHECK constraint `leads_status_check` para aceptar
 *      'liga_pago_enviada' (migración legacy nunca aplicada).
 *   2. Recibe un array de {phone_last10, target_status} y aplica el update
 *      por cada lead que tenga un status distinto del target.
 *
 * Auth: Bearer = process.env.MCP_API_TOKEN (mismo que /api/mcp)
 *
 * Body:
 *   { items: [{ phone_last10: '5575185301', target: 'liga_pago_enviada' }, ...] }
 *
 * Devuelve:
 *   { constraint_fix: { ok, error? }, sync: { total, updated, already, no_lead, failed } }
 */
type Status =
  | 'nuevo' | 'contactado' | 'llamada_con_dapta' | 'llamada_agendada'
  | 'no_show_llamada' | 'presentacion_enviada' | 'espera_aprobacion'
  | 'liga_pago_enviada' | 'convertido' | 'cliente_recurrente' | 'descartado'

const VALID_STATUSES: Status[] = [
  'nuevo', 'contactado', 'llamada_con_dapta', 'llamada_agendada',
  'no_show_llamada', 'presentacion_enviada', 'espera_aprobacion',
  'liga_pago_enviada', 'convertido', 'cliente_recurrente', 'descartado',
]

function checkAuth(req: NextRequest): boolean {
  const token = process.env.MCP_API_TOKEN
  if (!token) return false
  const header = req.headers.get('authorization') || ''
  const got = header.replace(/^Bearer\s+/i, '').trim()
  return got === token
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null) as
    | { items?: Array<{ phone_last10: string; target: string }> }
    | null
  if (!body?.items || !Array.isArray(body.items)) {
    return NextResponse.json({ error: 'items[] requerido' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // ── 1. Repair constraint via RPC. Si no existe, lo creamos primero. ──
  // Usamos pg_catalog para alter el check constraint. Supabase service role
  // tiene permisos suficientes para crear funciones y ejecutar DDL via RPC.
  let constraintFix: { ok: boolean; error?: string } = { ok: false }
  try {
    // Creamos la función SQL helper (idempotente)
    const sqlFn = `
      CREATE OR REPLACE FUNCTION admin_fix_status_constraint()
      RETURNS TEXT
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      BEGIN
        ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
        ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (
          status IN (
            'nuevo','contactado','llamada_con_dapta','llamada_agendada',
            'no_show_llamada','presentacion_enviada','espera_aprobacion',
            'liga_pago_enviada','convertido','cliente_recurrente','descartado'
          )
        );
        RETURN 'ok';
      END;
      $$;
    `
    // No hay forma estándar de ejecutar DDL via supabase-js sin una RPC ya creada.
    // Intentamos ejecutar la función. Si no existe, devolvemos instrucciones.
    const { error: rpcErr } = await supabase.rpc('admin_fix_status_constraint')
    if (rpcErr) {
      constraintFix = {
        ok: false,
        error: `RPC no existe. Ejecutá manualmente en Supabase SQL Editor:\n\n${sqlFn}\n\nSELECT admin_fix_status_constraint();`,
      }
    } else {
      constraintFix = { ok: true }
    }
  } catch (e) {
    constraintFix = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  // ── 2. Sync por phone_last10 ──
  const results = {
    total: body.items.length,
    updated: [] as Array<{ phone: string; id: string; from: string; to: string }>,
    already: [] as Array<{ phone: string; id: string; status: string }>,
    no_lead: [] as Array<{ phone: string }>,
    failed: [] as Array<{ phone: string; id: string; to: string; error: string }>,
  }

  for (const item of body.items) {
    const last10 = (item.phone_last10 || '').replace(/\D/g, '').slice(-10)
    if (last10.length < 10) {
      results.no_lead.push({ phone: item.phone_last10 })
      continue
    }
    if (!VALID_STATUSES.includes(item.target as Status)) {
      results.failed.push({ phone: last10, id: '?', to: item.target, error: 'status inválido' })
      continue
    }
    // Buscar lead — más reciente que matchee el last10
    const { data: leads } = await supabase
      .from('leads')
      .select('id, status, telefono')
      .like('telefono', `%${last10}`)
      .order('created_at', { ascending: false })
      .limit(1)
    const lead = leads?.[0]
    if (!lead) {
      results.no_lead.push({ phone: last10 })
      continue
    }
    if (lead.status === item.target) {
      results.already.push({ phone: last10, id: lead.id, status: lead.status })
      continue
    }
    const { error: upErr } = await supabase
      .from('leads')
      .update({ status: item.target, status_changed_at: new Date().toISOString() })
      .eq('id', lead.id)
    if (upErr) {
      results.failed.push({ phone: last10, id: lead.id, to: item.target, error: upErr.message })
      continue
    }
    // Activity log
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'status_change',
      descripcion: `Status cambiado a: ${item.target} (sync WhatsApp tag)`,
      metadata: { field: 'status', before: lead.status, after: item.target, source: 'wa_sync' },
    })
    results.updated.push({ phone: last10, id: lead.id, from: lead.status, to: item.target })
  }

  return NextResponse.json({
    constraint_fix: constraintFix,
    sync: {
      total: results.total,
      updated_count: results.updated.length,
      already_count: results.already.length,
      no_lead_count: results.no_lead.length,
      failed_count: results.failed.length,
      updated: results.updated,
      no_lead: results.no_lead,
      failed: results.failed,
    },
  })
}
