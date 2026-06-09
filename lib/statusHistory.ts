import type { Lead } from './supabase'
import { STATUS_PROJECTION_ORDER, STATUS_LABELS } from './status'

/**
 * Histórico de cambios de status — reconstruido desde lead_actividad.
 *
 * Cada cambio se inserta en lead_actividad con tipo='status_change' y
 * `descripcion = 'Status cambiado a: <new_status>'`. Aquí parseamos eso
 * y calculamos agregados.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Una fila de actividad relevante. */
export type StatusChangeRow = {
  lead_id: string
  to_status: Lead['status']
  changed_at: string  // ISO
}

/** Parsea el campo descripcion de lead_actividad → status destino. */
export function parseStatusFromDesc(desc: string | null | undefined): Lead['status'] | null {
  if (!desc) return null
  // formato: "Status cambiado a: <status>"
  const m = desc.match(/Status cambiado a:\s*([a-z_]+)/i)
  if (!m) return null
  const s = m[1].trim() as Lead['status']
  if (STATUS_PROJECTION_ORDER.includes(s)) return s
  return null
}

/** Histograma: cuántos leads ÚNICOS pasaron por cada stage en el rango. */
export type StagePassCount = {
  status: Lead['status']
  label: string
  unique_leads: number     // distinct lead_id que tocaron este stage
  changes: number          // total de transiciones hacia este stage (≥ unique_leads)
}

export function passCounts(rows: StatusChangeRow[]): StagePassCount[] {
  const counts = new Map<Lead['status'], { changes: number; leads: Set<string> }>()
  for (const r of rows) {
    const cur = counts.get(r.to_status) || { changes: 0, leads: new Set() }
    cur.changes += 1
    cur.leads.add(r.lead_id)
    counts.set(r.to_status, cur)
  }
  return STATUS_PROJECTION_ORDER.map(s => {
    const c = counts.get(s)
    return {
      status: s,
      label: STATUS_LABELS[s],
      unique_leads: c ? c.leads.size : 0,
      changes: c ? c.changes : 0,
    }
  }).filter(r => r.changes > 0)
}

/**
 * Para cada par (stage_from → stage_to) que tomó al menos un lead,
 * calcula el tiempo entre transiciones.
 *
 * Esto reconstruye la trayectoria de cada lead: ordena sus cambios por
 * fecha, mira pares consecutivos, y mide el tiempo entre uno y el siguiente.
 */
export type TransitionStats = {
  from: Lead['status']
  to: Lead['status']
  label: string  // "Contactado → Propuesta enviada"
  count: number
  avgDays: number
  medianDays: number
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Rank "natural" del funnel para detectar avances vs retrocesos.
 * Mayor número = más cerca de cierre. -1 = terminal lateral (descartado).
 */
const FUNNEL_RANK: Record<Lead['status'], number> = {
  nuevo: 0,
  contactado: 1,
  llamada_con_dapta: 1.5,
  llamada_agendada: 2,
  no_show_llamada: 2,
  presentacion_enviada: 3,
  espera_aprobacion: 4,
  liga_pago_enviada: 4.5,
  convertido: 5,
  cliente_recurrente: 5,
  descartado: -1,
}

/**
 * Para cada stage de origen, tiempo (en días) que tardan los leads en
 * AVANZAR al siguiente stage del funnel. Excluye self-loops y retrocesos.
 */
export type ForwardAdvance = {
  from: Lead['status']
  count: number
  avgDays: number
  medianDays: number
}

export function forwardAdvanceByStage(rows: StatusChangeRow[]): Map<Lead['status'], ForwardAdvance> {
  const byLead = new Map<string, StatusChangeRow[]>()
  for (const r of rows) {
    const arr = byLead.get(r.lead_id) || []
    arr.push(r)
    byLead.set(r.lead_id, arr)
  }
  const byFrom = new Map<Lead['status'], number[]>()  // from → array de días
  for (const arr of Array.from(byLead.values())) {
    arr.sort((a, b) => a.changed_at.localeCompare(b.changed_at))
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1], cur = arr[i]
      if (prev.to_status === cur.to_status) continue                  // self-loop
      if (FUNNEL_RANK[cur.to_status] <= FUNNEL_RANK[prev.to_status]) continue  // retroceso o lateral
      const t1 = new Date(prev.changed_at).getTime()
      const t2 = new Date(cur.changed_at).getTime()
      const days = (t2 - t1) / DAY_MS
      if (days < 0) continue
      const list = byFrom.get(prev.to_status) || []
      list.push(days)
      byFrom.set(prev.to_status, list)
    }
  }
  const out = new Map<Lead['status'], ForwardAdvance>()
  for (const [from, days] of Array.from(byFrom.entries())) {
    out.set(from, {
      from,
      count: days.length,
      avgDays: days.reduce((a, b) => a + b, 0) / days.length,
      medianDays: median(days),
    })
  }
  return out
}

export function transitionStats(rows: StatusChangeRow[]): TransitionStats[] {
  // Agrupar por lead, ordenar por fecha, sacar pares consecutivos.
  const byLead = new Map<string, StatusChangeRow[]>()
  for (const r of rows) {
    const arr = byLead.get(r.lead_id) || []
    arr.push(r)
    byLead.set(r.lead_id, arr)
  }

  const pairs = new Map<string, number[]>()  // key = "from→to", val = [days...]
  for (const arr of Array.from(byLead.values())) {
    arr.sort((a, b) => a.changed_at.localeCompare(b.changed_at))
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1], cur = arr[i]
      const t1 = new Date(prev.changed_at).getTime()
      const t2 = new Date(cur.changed_at).getTime()
      const days = (t2 - t1) / DAY_MS
      if (days < 0) continue
      const key = `${prev.to_status}→${cur.to_status}`
      const list = pairs.get(key) || []
      list.push(days)
      pairs.set(key, list)
    }
  }

  const out: TransitionStats[] = []
  for (const [key, days] of Array.from(pairs.entries())) {
    const [from, to] = key.split('→') as [Lead['status'], Lead['status']]
    out.push({
      from,
      to,
      label: `${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`,
      count: days.length,
      avgDays: days.reduce((a, b) => a + b, 0) / days.length,
      medianDays: median(days),
    })
  }

  // Ordenar por count desc (las transiciones más frecuentes primero).
  return out.sort((a, b) => b.count - a.count)
}

/**
 * Saltos LÓGICOS del funnel — no estrictamente consecutivos.
 *
 * Diferencia con `transitionStats`: aquella solo cuenta pares directos
 * (status[i] → status[i+1]). Si un lead va `presentacion_enviada →
 * espera_aprobacion → liga_pago_enviada → convertido`, la transición
 * `presentacion_enviada → convertido` NO se cuenta ahí.
 *
 * Esta función cuenta saltos del funnel ignorando intermedios. Para cada
 * par {from, to}, busca por lead la PRIMERA vez que tocó `from` y la
 * PRIMERA vez (posterior) que tocó `to`. Si ambas existen y to > from,
 * registra los días entre las dos.
 *
 * Útil cuando los pasos lógicos del funnel "engloban" varios status
 * técnicos. Ej: Fer define el funnel como Nuevo→Contactado→Llamada
 * agendada→Propuesta enviada→Convertido, pero "Convertido" puede pasar
 * por espera_aprobacion + liga_pago_enviada antes — todos esos llegan
 * al funnel paso 4.
 */
export function funnelTransitionStats(
  rows: StatusChangeRow[],
  jumps: Array<{ from: Lead['status']; to: Lead['status'] }>
): TransitionStats[] {
  const byLead = new Map<string, StatusChangeRow[]>()
  for (const r of rows) {
    const arr = byLead.get(r.lead_id) || []
    arr.push(r)
    byLead.set(r.lead_id, arr)
  }
  // Ordenar cada lead por tiempo asc.
  for (const arr of Array.from(byLead.values())) {
    arr.sort((a, b) => a.changed_at.localeCompare(b.changed_at))
  }

  const out: TransitionStats[] = []
  for (const { from, to } of jumps) {
    const days: number[] = []
    for (const arr of Array.from(byLead.values())) {
      // Primera ocurrencia de `from`
      const idxFrom = arr.findIndex(r => r.to_status === from)
      if (idxFrom === -1) continue
      // Primera ocurrencia de `to` DESPUÉS de la primera `from`
      const idxTo = arr.findIndex((r, i) => i > idxFrom && r.to_status === to)
      if (idxTo === -1) continue
      const t1 = new Date(arr[idxFrom].changed_at).getTime()
      const t2 = new Date(arr[idxTo].changed_at).getTime()
      const d = (t2 - t1) / DAY_MS
      if (d >= 0) days.push(d)
    }
    out.push({
      from,
      to,
      label: `${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`,
      count: days.length,
      avgDays: days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0,
      medianDays: median(days),
    })
  }
  return out
}
