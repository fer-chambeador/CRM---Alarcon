import type { Lead } from './supabase'
import { PIPELINE_CLOSED, STATUS_PROJECTION_ORDER, STATUS_LABELS } from './status'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Días que el lead lleva en su stage actual.
 *
 * Para leads en 'contactado', usamos MAX(status_changed_at, ultimo_contacto)
 * para que el aging se REINICIE cuando se marca un nuevo intento de contacto.
 * Para los demás stages, usamos status_changed_at.
 */
export function daysInCurrentStage(lead: Lead, now: number = Date.now()): number {
  let ts = lead.status_changed_at ? new Date(lead.status_changed_at).getTime() : new Date(lead.created_at).getTime()
  if (lead.status === 'contactado' && lead.ultimo_contacto) {
    const tsContacto = new Date(lead.ultimo_contacto).getTime()
    if (isFinite(tsContacto) && tsContacto > ts) ts = tsContacto
  }
  if (!isFinite(ts)) return 0
  return Math.max(0, (now - ts) / DAY_MS)
}

/** Categoriza un aging en días en un bucket para colorear UI. */
export type AgingBucket = 'fresh' | 'warming' | 'cold' | 'frozen'
export function agingBucket(days: number): AgingBucket {
  if (days < 7) return 'fresh'
  if (days < 14) return 'warming'
  if (days < 30) return 'cold'
  return 'frozen'
}
export const AGING_COLOR: Record<AgingBucket, string> = {
  fresh: '#22d68a',
  warming: '#f5c842',
  cold: '#f5914e',
  frozen: '#f05a5a',
}
export const AGING_LABEL: Record<AgingBucket, string> = {
  fresh:   '0–7 días',
  warming: '7–14 días',
  cold:    '14–30 días',
  frozen:  '>30 días',
}

/** "3 d", "12 d", "45 d" — formato corto para el chip. */
export function fmtAgingShort(days: number): string {
  if (days < 1) return '<1d'
  if (days < 100) return `${Math.round(days)}d`
  return `${Math.round(days / 30)}m`
}

/** Mediana de un arreglo de números. */
function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Aging stats por stage (de los leads que ESTÁN actualmente en ese stage). */
export type StageAging = {
  status: Lead['status']
  label: string
  count: number
  avgDays: number
  medianDays: number
  stuckCount: number          // leads con > 14 días en stage
}
export function agingByStage(leads: Lead[], now: number = Date.now()): StageAging[] {
  return STATUS_PROJECTION_ORDER.map(status => {
    const inStage = leads.filter(l => l.status === status)
    const ages = inStage.map(l => daysInCurrentStage(l, now))
    const avg = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : 0
    return {
      status,
      label: STATUS_LABELS[status],
      count: inStage.length,
      avgDays: avg,
      medianDays: median(ages),
      stuckCount: ages.filter(d => d > 14).length,
    }
  })
}

/** Tiempo de ciclo: días entre `created_at` y `status_changed_at` para los leads ya cerrados. */
export type CycleStats = {
  count: number
  avgDays: number
  medianDays: number
}
export function cycleStats(leads: Lead[]): CycleStats {
  const closed = leads.filter(l => PIPELINE_CLOSED.includes(l.status))
  const days = closed.map(l => {
    const start = new Date(l.created_at).getTime()
    const end = l.status_changed_at ? new Date(l.status_changed_at).getTime() : new Date(l.updated_at).getTime()
    return Math.max(0, (end - start) / DAY_MS)
  })
  const avg = days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0
  return {
    count: closed.length,
    avgDays: avg,
    medianDays: median(days),
  }
}
