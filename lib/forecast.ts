import type { Lead } from './supabase'
import { DEFAULT_MONTO, PIPELINE_CLOSED } from './status'

/**
 * Probabilidad de cierre por stage (V1, hardcoded).
 *
 * Esto define cuánto aporta cada lead al "forecast del periodo":
 *   forecast = Σ (monto_del_lead × prob_de_su_stage)
 *
 * Los % son razonables como punto de partida; cuando haya suficiente
 * data histórica los podemos calibrar contra la conversion rate real.
 */
export const STATUS_WIN_PROBABILITY: Record<Lead['status'], number> = {
  nuevo: 0.05,
  contactado: 0.10,
  llamada_agendada: 0.25,
  no_show_llamada: 0.05,
  presentacion_enviada: 0.50,
  espera_aprobacion: 0.80,
  convertido: 1.00,
  cliente_recurrente: 1.00,
  descartado: 0.00,
}

/** Monto efectivo del lead (con default si viene null). */
export function leadMonto(l: Lead): number {
  return l.monto ?? DEFAULT_MONTO
}

/**
 * Forecast total ponderado sobre un conjunto de leads.
 * Suma monto × probabilidad por cada lead.
 */
export function forecastLeads(leads: Lead[]): number {
  let total = 0
  for (const l of leads) {
    total += leadMonto(l) * STATUS_WIN_PROBABILITY[l.status]
  }
  return total
}

/**
 * Desglose del forecast por stage — útil para mostrar de dónde sale el
 * número proyectado.
 */
export type ForecastBucket = {
  status: Lead['status']
  count: number
  monto: number              // total nominal del stage (sin ponderar)
  contribution: number       // aporte ponderado al forecast (monto × prob)
  probability: number
}

export function forecastByStage(leads: Lead[]): ForecastBucket[] {
  const map = new Map<Lead['status'], ForecastBucket>()
  for (const l of leads) {
    const monto = leadMonto(l)
    const prob = STATUS_WIN_PROBABILITY[l.status]
    const existing = map.get(l.status)
    if (existing) {
      existing.count += 1
      existing.monto += monto
      existing.contribution += monto * prob
    } else {
      map.set(l.status, {
        status: l.status,
        count: 1,
        monto,
        contribution: monto * prob,
        probability: prob,
      })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.contribution - a.contribution)
}

/** Sumatoria del cerrado real (convertido + recurrente) en este set. */
export function realClosedTotal(leads: Lead[]): number {
  let total = 0
  for (const l of leads) {
    if (PIPELINE_CLOSED.includes(l.status)) total += leadMonto(l)
  }
  return total
}
