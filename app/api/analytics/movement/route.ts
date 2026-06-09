import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { parseStatusFromDesc, passCounts, transitionStats, funnelTransitionStats, forwardAdvanceByStage, type StatusChangeRow, type ForwardAdvance } from '@/lib/statusHistory'
import type { Lead } from '@/lib/supabase'

/**
 * Saltos lógicos del funnel definidos por Fer (9-jun-2026):
 * Estos saltos no son estrictamente consecutivos — el #4 engloba
 * presentacion_enviada → espera_aprobacion → liga_pago_enviada → convertido.
 */
const FUNNEL_JUMPS: Array<{ from: Lead['status']; to: Lead['status'] }> = [
  { from: 'nuevo',                to: 'contactado'           },
  { from: 'contactado',           to: 'llamada_agendada'     },
  { from: 'llamada_agendada',     to: 'presentacion_enviada' },
  { from: 'presentacion_enviada', to: 'convertido'           },
]

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/analytics/movement?from=ISO&to=ISO
 *
 * Devuelve agregados desde lead_actividad sobre las transiciones de status:
 *  - passCounts: cuántos leads pasaron por cada stage en el rango
 *  - transitions: tiempo promedio/mediana entre stages consecutivos
 *
 * FIX (7-jun-2026): antes `transitions` solo cubría leads que tuvieron status
 * change DENTRO del rango, lo que daba muy pocos casos (7-9). Ahora pulla
 * TODOS los status changes históricos y calcula promedios globales para los
 * 4 saltos principales del funnel. El filtro de rango sigue aplicando a
 * passCounts (cuántos leads pasaron por cada stage en el mes).
 */
export async function GET(req: NextRequest) {
  const supabase = createServiceClient()
  const url = new URL(req.url)
  const fromISO = url.searchParams.get('from')
  const toISO = url.searchParams.get('to')

  // Para passCounts: solo los cambios dentro del rango.
  let qRange = supabase.from('lead_actividad').select('lead_id, descripcion, created_at')
    .eq('tipo', 'status_change')
  if (fromISO) qRange = qRange.gte('created_at', fromISO)
  if (toISO) qRange = qRange.lte('created_at', toISO)
  const { data: rangeRows, error: e1 } = await qRange.limit(50000)
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 })

  const inRange: StatusChangeRow[] = []
  for (const r of (rangeRows || []) as Array<{ lead_id: string; descripcion: string | null; created_at: string }>) {
    const s = parseStatusFromDesc(r.descripcion)
    if (s) inRange.push({ lead_id: r.lead_id, to_status: s, changed_at: r.created_at })
  }

  // Para transitions y advance: TODOS los cambios de status históricos
  // (sin filtro por rango), para tener máxima muestra estadística.
  const { data: allRows, error: e2 } = await supabase
    .from('lead_actividad')
    .select('lead_id, descripcion, created_at')
    .eq('tipo', 'status_change')
    .limit(100000)
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })
  const allParsed: StatusChangeRow[] = []
  for (const r of (allRows || []) as Array<{ lead_id: string; descripcion: string | null; created_at: string }>) {
    const s = parseStatusFromDesc(r.descripcion)
    if (s) allParsed.push({ lead_id: r.lead_id, to_status: s, changed_at: r.created_at })
  }
  const transitions = transitionStats(allParsed)
  // Saltos lógicos del funnel (no consecutivos) — para "Tiempos de conversión"
  // donde un paso del funnel engloba múltiples status técnicos.
  const funnel = funnelTransitionStats(allParsed, FUNNEL_JUMPS)
  const advMap = forwardAdvanceByStage(allParsed)
  const advance: Record<Lead['status'], ForwardAdvance> | Record<string, never> =
    Object.fromEntries(advMap.entries()) as Record<Lead['status'], ForwardAdvance>

  return NextResponse.json({
    range: { from: fromISO, to: toISO },
    passCounts: passCounts(inRange),
    transitions,
    funnel,
    advance,
    sample_size: inRange.length,
  })
}
