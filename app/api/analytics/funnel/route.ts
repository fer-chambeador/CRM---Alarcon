import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, fetchAllRows } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

/**
 * GET /api/analytics/funnel?from=ISO&to=ISO
 *
 * Funnel de outbound: para cada etapa, count actual + count de leads que
 * PASARON por esa etapa en su historia + tiempo mediana en days entre
 * etapas consecutivas. Etapas:
 *   nuevo → contactado → llamada_agendada → llamada_con_dapta →
 *   presentacion_enviada → convertido / cliente_recurrente.
 *
 * "Pasaron por etapa X" = el lead tiene un registro en lead_actividad de
 * tipo 'status_change' donde metadata.after === X, O su status actual
 * está en o más adelante que X en el orden del funnel.
 *
 * Tiempo entre etapas = mediana de los días que tardó un lead en pasar
 * de A→B, calculado leyendo lead_actividad ordenado por created_at.
 *
 * Filtros from/to aplican a `lead.created_at` (cuando el lead entró al
 * funnel). Sin filtro = todos.
 */

// Recurrente quitado del funnel (user request, 3 jun 2026): un cliente recurrente
// ya está convertido — duplicar en el funnel ruidoso para la vista de captación.
const STAGES = ['nuevo', 'contactado', 'llamada_agendada', 'presentacion_enviada', 'convertido'] as const
type Stage = typeof STAGES[number]

const STAGE_LABEL: Record<Stage, string> = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  llamada_agendada: 'Llamada agendada',

  presentacion_enviada: 'Presentación enviada',
  convertido: 'Convertido',
}

// Rank en el funnel — un lead en "presentacion_enviada" YA pasó por todas las anteriores.
const STAGE_RANK: Record<Stage, number> = {
  nuevo: 0,
  contactado: 1,
  llamada_agendada: 2,

  presentacion_enviada: 4,
  convertido: 5,
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to') || new Date().toISOString()
  const supabase = createServiceClient()

  // 1. Pull leads en el rango (paginado — Supabase capa a 1000 por request).
  type LeadRow = { id: string; status: string; created_at: string; status_changed_at: string | null }
  let leads: LeadRow[]
  try {
    leads = await fetchAllRows<LeadRow>((rFrom, rTo) => {
      let q = supabase
        .from('leads')
        .select('id, status, created_at, status_changed_at')
        .lte('created_at', to)
      if (from) q = q.gte('created_at', from)
      return q.order('created_at', { ascending: true }).range(rFrom, rTo)
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'leads fetch failed' }, { status: 500 })
  }
  const leadIds = leads.map(l => l.id)

  // 2. Pull lead_actividad status_change events para esos leads.
  type ActRow = { lead_id: string; metadata: Record<string, unknown> | null; created_at: string }
  const acts: ActRow[] = []
  if (leadIds.length > 0) {
    // Chunkear ids (URLs muy largas truenan con miles de ids) y paginar
    // cada chunk (cap de 1000 filas por request de Supabase).
    const CHUNK = 400
    for (let i = 0; i < leadIds.length; i += CHUNK) {
      const idsChunk = leadIds.slice(i, i + CHUNK)
      const chunkActs = await fetchAllRows<ActRow>((rFrom, rTo) =>
        supabase
          .from('lead_actividad')
          .select('lead_id, metadata, created_at')
          .in('lead_id', idsChunk)
          .eq('tipo', 'status_change')
          .order('created_at', { ascending: true })
          .range(rFrom, rTo),
      )
      acts.push(...chunkActs)
    }
    acts.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  // 3. Agrupar transiciones por lead.
  // Para cada lead, reconstruimos la secuencia: lead.created_at (= nuevo) +
  // cada status_change con su timestamp.
  const transitionsByLead = new Map<string, Array<{ stage: Stage; at: number }>>()
  for (const l of leads) {
    transitionsByLead.set(l.id, [{ stage: 'nuevo', at: new Date(l.created_at).getTime() }])
  }
  for (const a of acts) {
    const after = a.metadata && (a.metadata as { after?: string }).after
    if (!after || !STAGES.includes(after as Stage)) continue
    const arr = transitionsByLead.get(a.lead_id) || []
    arr.push({ stage: after as Stage, at: new Date(a.created_at).getTime() })
    transitionsByLead.set(a.lead_id, arr)
  }

  // 4. Para cada etapa: cuántos leads la "tocaron" (current rank >= etapa OR
  //    pasaron por ella en su historia).
  const reachedByStage: Record<Stage, Set<string>> = Object.fromEntries(
    STAGES.map(s => [s, new Set<string>()]),
  ) as Record<Stage, Set<string>>

  for (const l of leads) {
    // 'cliente_recurrente' es un super-set de 'convertido' (ya pagó al menos una vez),
    // así que para el funnel lo tratamos como 'convertido' (rank 5). No tener un
    // rank propio simplifica el funnel sin perder el cliente del conteo final.
    const effectiveStatus = l.status === 'cliente_recurrente' ? 'convertido' : l.status
    const currentRank = STAGE_RANK[effectiveStatus as Stage] ?? -1
    const history = transitionsByLead.get(l.id) || []
    for (const s of STAGES) {
      const sRank = STAGE_RANK[s]
      // Lead llegó a la etapa s si su current rank >= s, O en historia tocó s
      if (currentRank >= sRank || history.some(h => h.stage === s)) {
        reachedByStage[s].add(l.id)
      }
    }
  }

  // 5. Tiempos entre etapas consecutivas — para cada par (A, B) donde B = A+1,
  //    mediana del delta para los leads que pasaron por ambos.
  const transitionTimings: Array<{ from: Stage; to: Stage; medianDays: number | null; sampleSize: number }> = []
  const historyArray: Array<Array<{ stage: Stage; at: number }>> = Array.from(transitionsByLead.values())
  for (let i = 0; i < STAGES.length - 1; i++) {
    const a = STAGES[i]
    const b = STAGES[i + 1]
    const deltas: number[] = []
    for (const history of historyArray) {
      const aEvent = history.find((h: { stage: Stage; at: number }) => h.stage === a)
      const bEvent = history.find((h: { stage: Stage; at: number }) => h.stage === b)
      if (aEvent && bEvent && bEvent.at > aEvent.at) {
        deltas.push((bEvent.at - aEvent.at) / 86400_000)
      }
    }
    transitionTimings.push({
      from: a,
      to: b,
      medianDays: median(deltas),
      sampleSize: deltas.length,
    })
  }

  // 6. Build response — para cada etapa: count reached + % vs etapa anterior.
  const stages = STAGES.map((s) => {
    const count = reachedByStage[s].size
    return {
      stage: s,
      label: STAGE_LABEL[s],
      count,
    }
  })

  // Conversion rate etapa-a-etapa: count[i+1] / count[i]
  const conversion = stages.map((s, i) => {
    if (i === 0) return { stage: s.stage, rate: 1, label: 'Base' }
    const prev = stages[i - 1].count
    return {
      stage: s.stage,
      rate: prev > 0 ? s.count / prev : 0,
      label: `${prev} → ${s.count}`,
    }
  })

  const res = NextResponse.json({
    range: { from, to },
    total_leads: leads.length,
    stages,
    conversion,
    timings: transitionTimings,
  })
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  return res
}
