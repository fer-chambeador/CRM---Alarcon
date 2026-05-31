import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { triggerDaptaCall } from '@/lib/dapta'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/dapta/trigger
 *
 * Body: { lead_id: string, trigger_reason?: string, triggered_by?: string }
 *
 * 1. Lee el lead.
 * 2. Hace POST al Flow A de Dapta con el contexto del lead.
 * 3. Crea una fila en `llamadas` (status='queued') con los datos iniciales.
 *    El dapta_call_id se completa cuando llega el webhook post-call.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    lead_id?: string
    trigger_reason?: string
    triggered_by?: string
  } | null

  if (!body?.lead_id) {
    return NextResponse.json({ error: 'lead_id requerido' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', body.lead_id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!lead) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })

  const l = lead as Lead
  if (!l.telefono) {
    return NextResponse.json({ error: 'el lead no tiene teléfono' }, { status: 400 })
  }
  if (l.email?.endsWith('@chambas.placeholder')) {
    // permitimos pero advertimos — la AI no podrá referenciar email
  }

  const triggerResult = await triggerDaptaCall({
    lead_id: l.id,
    to_number: l.telefono,
    nombre: l.nombre,
    empresa: l.empresa,
    vacante: l.vacante,
    presupuesto: l.presupuesto,
    puesto: l.puesto,
    notas: l.notas,
  })

  // Crear row en llamadas con estado inicial
  const insert: Record<string, unknown> = {
    lead_id: l.id,
    to_number: l.telefono,
    from_number: process.env.DAPTA_FROM_NUMBER || null,
    agent_name: process.env.DAPTA_AGENT_NAME_DEFAULT || 'Daniela',
    status: triggerResult.ok ? 'queued' : 'failed',
    triggered_by: body.triggered_by || null,
    trigger_reason: body.trigger_reason || 'manual',
    error_message: triggerResult.ok ? null : (triggerResult.error || 'unknown'),
  }

  const { data: created, error: insErr } = await supabase
    .from('llamadas')
    .insert(insert)
    .select('id')
    .maybeSingle()

  if (insErr) {
    console.error('Error creando llamada:', insErr)
    return NextResponse.json({
      ok: triggerResult.ok,
      dapta: triggerResult,
      db_error: insErr.message,
    }, { status: 500 })
  }

  const llamadaId = (created as { id?: string } | null)?.id

  // Loguear actividad en el timeline del lead
  if (llamadaId) {
    await supabase.from('lead_actividad').insert({
      lead_id: l.id,
      tipo: 'dapta_call_triggered',
      descripcion: triggerResult.ok
        ? `📞 Llamada Dapta disparada a ${l.telefono}`
        : `❌ Falló disparo de llamada Dapta: ${triggerResult.error}`,
      metadata: { source: 'dapta', llamada_id: llamadaId, trigger_reason: body.trigger_reason, ok: triggerResult.ok },
    })
  }

  return NextResponse.json({
    ok: triggerResult.ok,
    llamada_id: llamadaId,
    dapta: triggerResult.ok ? { status: triggerResult.status } : triggerResult,
  }, { status: triggerResult.ok ? 200 : 502 })
}
