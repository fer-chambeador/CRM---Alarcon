import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { parseStatusFromDesc, passCounts, transitionStats, type StatusChangeRow } from '@/lib/statusHistory'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/analytics/movement?from=ISO&to=ISO
 *
 * Devuelve agregados desde lead_actividad sobre las transiciones de status:
 *  - passCounts: cuántos leads pasaron por cada stage en el rango
 *  - transitions: tiempo promedio/mediana entre stages consecutivos
 *
 * Nota: para `transitions` levantamos TODOS los cambios de status del lead
 * (no filtramos por rango) porque para medir un tránsito Contactado→Propuesta
 * necesitamos los dos timestamps. El filtro de rango se aplica al RESULTADO
 * (cuándo ocurrió el segundo cambio).
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

  // Para transitions: TODOS los cambios, pero solo de los leads que tuvieron
  // movimiento en el rango (optimización para no traer todo).
  const leadIds = Array.from(new Set(inRange.map(r => r.lead_id)))
  let transitions: ReturnType<typeof transitionStats> = []
  if (leadIds.length > 0) {
    const { data: allRows, error: e2 } = await supabase
      .from('lead_actividad')
      .select('lead_id, descripcion, created_at')
      .eq('tipo', 'status_change')
      .in('lead_id', leadIds)
      .limit(50000)
    if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })
    const allParsed: StatusChangeRow[] = []
    for (const r of (allRows || []) as Array<{ lead_id: string; descripcion: string | null; created_at: string }>) {
      const s = parseStatusFromDesc(r.descripcion)
      if (s) allParsed.push({ lead_id: r.lead_id, to_status: s, changed_at: r.created_at })
    }
    transitions = transitionStats(allParsed)
  }

  return NextResponse.json({
    range: { from: fromISO, to: toISO },
    passCounts: passCounts(inRange),
    transitions,
    sample_size: inRange.length,
  })
}
