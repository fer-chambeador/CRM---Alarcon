import type { Lead } from './supabase'

/**
 * Heurística de calificación 0–100.
 * Combina señales actuales en el CRM:
 *  - presupuesto declarado en onboarding (max 40)
 *  - canal de adquisición (max 20)
 *  - decision maker / puesto (max 20)
 *  - completitud + engagement (max 20)
 *
 * Es deterministic — no cachea, se computa cada vez. Cambiá los pesos
 * y todo el sistema (badge en tabla, sort, NBA priority) se actualiza.
 */

const PRESUPUESTO_POINTS: Record<string, number> = {
  none: 0,
  '100_to_1000': 15,
  '2000_to_5000': 28,
  '10000_plus': 40,
}

const CANAL_POINTS: Record<string, number> = {
  Inbound: 20,
  'Recomendación': 20,
  Google: 14,
  LinkedIn: 14,
  WhatsApp: 12,
  Facebook: 10,
  Instagram: 10,
  TikTok: 6,
}

function puestoPoints(p: string | null): number {
  if (!p) return 0
  const s = p.toLowerCase()
  if (/(due[ñn]|ceo|director|socio|fundador|owner)/i.test(s)) return 20
  if (/(reclut|rh|recursos hum|gerente|head|manager|jefe)/i.test(s)) return 12
  return 6
}

export function leadScore(lead: Lead): number {
  let score = 0

  if (lead.presupuesto) score += PRESUPUESTO_POINTS[lead.presupuesto] ?? 0
  if (lead.canal_adquisicion) score += CANAL_POINTS[lead.canal_adquisicion] ?? 0
  score += puestoPoints(lead.puesto)

  // Completitud + engagement (max 20)
  if (lead.empresa) score += 5
  if (lead.estado) score += 3
  if (lead.vacante) score += 5
  if ((lead.veces_contactado || 0) >= 1) score += 4
  if ((lead.veces_contactado || 0) >= 2) score += 3

  return Math.max(0, Math.min(100, score))
}

export type ScoreBucket = 'hot' | 'warm' | 'cold'

export function scoreBucket(s: number): ScoreBucket {
  if (s >= 60) return 'hot'
  if (s >= 30) return 'warm'
  return 'cold'
}

export const SCORE_BUCKET_LABEL: Record<ScoreBucket, string> = {
  hot: 'Hot',
  warm: 'Warm',
  cold: 'Cold',
}

export const SCORE_BUCKET_COLOR: Record<ScoreBucket, string> = {
  hot: '#ff5a5a',
  warm: '#ffba3d',
  cold: '#4ea8f5',
}

export const SCORE_BUCKET_EMOJI: Record<ScoreBucket, string> = {
  hot: '🔥',
  warm: '✨',
  cold: '❄️',
}
