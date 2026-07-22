import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SECRET = 'admin_backfill_scd_2026'

/**
 * GET /api/admin/backfill-status-changed-at?secret=...&dry=1
 *
 * Reconstruye status_changed_at de los leads CERRADOS (convertido /
 * cliente_recurrente) desde el log de actividad. Los cambios manuales
 * via PATCH historicamente NO estampaban la fecha, asi que las metricas
 * por fecha de conversion salian infladas con fechas sucias.
 *
 * Fuente de verdad, en orden:
 *   1. Ultima actividad tipo='status_change' con metadata.after == status actual
 *   2. Ultima actividad tipo='vambe_stage_change' cuya descripcion contiene
 *      "CRM status -> <status actual>"
 *   3. Sin evidencia -> lead.created_at
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  if (url.searchParams.get('secret') !== SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const dry = url.searchParams.get('dry') === '1'
  const supabase = createServiceClient()

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, status, status_changed_at, created_at')
    .in('status', ['convertido', 'cliente_recurrente'])
    .limit(2000)
  if (error || !leads) {
    return NextResponse.json({ error: error?.message || 'no leads' }, { status: 500 })
  }

  const best = new Map<string, string>()
  const CHUNK = 20
  for (let i = 0; i < leads.length; i += CHUNK) {
    const chunk = leads.slice(i, i + CHUNK)
    const statusById = new Map(chunk.map(l => [l.id as string, l.status as string]))
    const { data: acts } = await supabase
      .from('lead_actividad')
      .select('lead_id, tipo, descripcion, metadata, created_at')
      .in('lead_id', chunk.map(l => l.id))
      .in('tipo', ['status_change', 'vambe_stage_change'])
      .order('created_at', { ascending: true })
      .limit(1000)
    for (const a of acts || []) {
      const want = statusById.get(a.lead_id as string)
      if (!want) continue
      const after = a.tipo === 'status_change'
        ? ((a.metadata as { after?: string } | null) || {}).after
        : ((a.descripcion || '').match(/CRM status → (\w+)/) || [])[1]
      if (after === want) best.set(a.lead_id as string, a.created_at as string)
    }
  }

  let conEvidencia = 0
  let sinEvidencia = 0
  let sinCambio = 0
  const updates: Array<{ id: string; ts: string }> = []
  for (const l of leads) {
    const ts = best.get(l.id as string) || (l.created_at as string)
    if (best.has(l.id as string)) conEvidencia += 1
    else sinEvidencia += 1
    const cur = l.status_changed_at ? new Date(l.status_changed_at as string).getTime() : 0
    if (cur && Math.abs(cur - new Date(ts).getTime()) < 60_000) {
      sinCambio += 1
      continue
    }
    updates.push({ id: l.id as string, ts })
  }

  if (!dry) {
    for (const u of updates) {
      await supabase.from('leads').update({ status_changed_at: u.ts }).eq('id', u.id)
    }
  }

  return NextResponse.json({
    dry,
    total_cerrados: leads.length,
    con_evidencia: conEvidencia,
    sin_evidencia_usan_created_at: sinEvidencia,
    sin_cambio: sinCambio,
    actualizados: updates.length,
  })
}
