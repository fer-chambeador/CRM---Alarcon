import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { triggerDaptaCall } from '@/lib/dapta'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/dapta/cron-trigger-scheduled?secret=<DAPTA_POST_CALL_SECRET>
 *
 * Cron endpoint. Cada minuto (o lo que configures en Railway/Vercel cron):
 *   - Busca llamadas con status='queued' AND scheduled_at <= now() AND dapta_call_id IS NULL
 *   - Para cada una, dispara Dapta y mueve el lead a 'llamada_con_dapta'
 *
 * Para que sea seguro pero llamable desde Railway/cron-job.org, lo gateamos con
 * el mismo secret de post-call (DAPTA_POST_CALL_SECRET).
 *
 * Idempotente: si por algún motivo se llama 2× para la misma fila, el segundo
 * intento la encuentra ya con dapta_call_id o ya disparada y la salta.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || req.headers.get('x-dapta-secret')
  if (!process.env.DAPTA_POST_CALL_SECRET || secret !== process.env.DAPTA_POST_CALL_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const nowIso = new Date().toISOString()
  const limit = parseInt(url.searchParams.get('limit') || '20', 10)

  const { data: pending, error } = await supabase
    .from('llamadas')
    .select('id, lead_id, scheduled_at, status')
    .eq('status', 'queued')
    .is('dapta_call_id', null)
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (pending || []) as Array<{ id: string; lead_id: string | null; scheduled_at: string; status: string }>
  const results: Array<{ llamada_id: string; ok: boolean; reason?: string }> = []

  const ADVANCED = new Set(['llamada_agendada', 'no_show_llamada', 'presentacion_enviada', 'espera_aprobacion', 'convertido', 'cliente_recurrente'])

  for (const row of rows) {
    if (!row.lead_id) { results.push({ llamada_id: row.id, ok: false, reason: 'no lead_id' }); continue }

    // ── OPTIMISTIC LOCK: marcar 'dialing' ANTES de llamar a Dapta ──
    // Esto previene el bug que vimos donde la fila se quedaba en 'queued' y el
    // siguiente cron tick la volvía a disparar (Olvera fue llamada N veces).
    // Solo actualizamos si SIGUE en 'queued' — si otro worker ya la tomó,
    // .update().eq('status','queued') no afecta filas y obtenemos array vacío.
    const { data: locked, error: lockErr } = await supabase
      .from('llamadas')
      .update({ status: 'dialing', trigger_reason: 'scheduled_fired' })
      .eq('id', row.id)
      .eq('status', 'queued')
      .select('id')
    if (lockErr || !locked || locked.length === 0) {
      results.push({ llamada_id: row.id, ok: false, reason: 'already-processed-or-lock-failed' })
      continue
    }

    const { data: leadData } = await supabase.from('leads').select('*').eq('id', row.lead_id).maybeSingle()
    const lead = leadData as Lead | null
    if (!lead) {
      await supabase.from('llamadas').update({ status: 'failed', error_message: 'lead not found' }).eq('id', row.id)
      results.push({ llamada_id: row.id, ok: false, reason: 'lead not found' })
      continue
    }
    if (!lead.telefono) {
      await supabase.from('llamadas').update({ status: 'failed', error_message: 'lead sin teléfono al disparar agendada' }).eq('id', row.id)
      results.push({ llamada_id: row.id, ok: false, reason: 'no phone' })
      continue
    }

    const triggerResult = await triggerDaptaCall({
      lead_id: lead.id,
      to_number: lead.telefono,
      nombre: lead.nombre,
      empresa: lead.empresa,
      vacante: lead.vacante,
      presupuesto: lead.presupuesto,
      puesto: lead.puesto,
      notas: lead.notas,
    })

    if (triggerResult.ok) {
      // Status ya está 'dialing' (set arriba con lock). El post-call la moverá a 'completed'.
      // Mover lead a llamada_con_dapta si no está en etapa más avanzada
      if (!ADVANCED.has(lead.status)) {
        await supabase.from('leads').update({
          status: 'llamada_con_dapta',
          status_changed_at: new Date().toISOString(),
        }).eq('id', lead.id)
      }

      await supabase.from('lead_actividad').insert({
        lead_id: lead.id,
        tipo: 'dapta_call_triggered',
        descripcion: `📞 Llamada Dapta agendada disparada (estaba programada para ${new Date(row.scheduled_at).toLocaleString('es-MX')})`,
        metadata: { source: 'dapta-cron', llamada_id: row.id, scheduled_at: row.scheduled_at },
      })
      results.push({ llamada_id: row.id, ok: true })
    } else {
      await supabase.from('llamadas').update({
        status: 'failed',
        error_message: triggerResult.error || 'unknown',
      }).eq('id', row.id)
      results.push({ llamada_id: row.id, ok: false, reason: triggerResult.error })
    }
  }

  return NextResponse.json({
    now: nowIso,
    candidates: rows.length,
    triggered: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  })
}
