import type { Lead } from './supabase'
import { leadScore, scoreBucket } from './scoring'

/**
 * Lógica del approval queue del flujo de ventas.
 *
 * Reglas (ver chat 2026-05-31 con Fer):
 *   - Lead inbound nuevo + baja calificación + 30 min sin contacto
 *       → encolar Vambe template 'outbound_primer_mensaje_sales' (var: empresa)
 *   - Lead inbound nuevo + alta calificación
 *       → no automatizar, el user le escribe a mano
 *   - Lead baja calificación + status='llamada_agendada' + llamada en el futuro
 *       → encolar llamada Dapta (Daniela) a la hora del lead
 *   - Lead alta calificación + status='llamada_agendada'
 *       → no automatizar, llamada manual
 *
 * "Baja calificación" = scoreBucket(leadScore(lead)) !== 'hot'  (warm / cold)
 * "Alta calificación" = scoreBucket(leadScore(lead)) === 'hot'  (score ≥60)
 */

export const VAMBE_AGENDA_TEMPLATE_NAME = 'outbound_primer_mensaje_sales'

export type AprobacionTipo = 'vambe_template' | 'dapta_call'
export type AprobacionStatus = 'pending' | 'approved' | 'rejected_manual' | 'failed' | 'expired'

export type Aprobacion = {
  id: string
  tipo: AprobacionTipo
  lead_id: string
  status: AprobacionStatus
  template_id: string | null
  template_name: string | null
  scheduled_at: string | null
  reason: string | null
  score_snapshot: number | null
  result_metadata: Record<string, unknown>
  error_message: string | null
  created_at: string
  decided_at: string | null
  expires_at: string | null
}

/** Decide si el lead califica para Vambe template outbound (baja calificación + inbound + nuevo + 30min+ sin contacto). */
export function isVambeTemplateCandidate(lead: Lead, ageMinutes: number): {
  candidate: boolean
  reason: string
} {
  const score = leadScore(lead)
  const bucket = scoreBucket(score)

  if (lead.status !== 'nuevo') {
    return { candidate: false, reason: `lead.status=${lead.status} (esperaba 'nuevo')` }
  }
  if (bucket === 'hot') {
    return { candidate: false, reason: `lead es hot (${score} pts) — manual` }
  }
  if (ageMinutes < 30) {
    return { candidate: false, reason: `lead creado hace ${Math.round(ageMinutes)} min — aún < 30` }
  }
  if (!lead.telefono) {
    return { candidate: false, reason: 'lead sin teléfono — no se puede mandar Vambe' }
  }
  return {
    candidate: true,
    reason: `Baja calificación (${score} pts · ${bucket}) · ${Math.round(ageMinutes)} min sin contactar`,
  }
}

/** Decide si el lead califica para Dapta call. **TODAS** las llamadas
 *  agendadas pasan por el queue de outbound, sin importar score.
 *
 *  Cambio (2 jun 2026): antes la regla excluía leads `hot` (score ≥60) bajo
 *  la idea de "los hot los llama Fer a mano". En la práctica resultó al
 *  revés: Daniela cerró clientes hot (Miriam, Patricia, etc.) con tasa
 *  alta, y dejar fuera del queue a los hot significaba que Fer los olvidaba
 *  o llegaba tarde. Ahora TODOS los leads con status='llamada_agendada'
 *  califican; el score sigue mostrándose como chip en la UI para que el
 *  user decida si los marca como Manual o los manda a Daniela.
 *
 *  Vambe templates (isVambeTemplateCandidate) SIGUE excluyendo hot — un
 *  template genérico a un lead caliente sería contra-productivo; mejor un
 *  primer mensaje manual personalizado.
 */
export function isDaptaCallCandidate(lead: Lead): {
  candidate: boolean
  reason: string
} {
  const score = leadScore(lead)
  const bucket = scoreBucket(score)

  if (lead.status !== 'llamada_agendada') {
    return { candidate: false, reason: `lead.status=${lead.status} (esperaba 'llamada_agendada')` }
  }
  if (!lead.llamada_at) {
    return { candidate: false, reason: 'lead sin llamada_at — no se puede agendar Dapta' }
  }
  const llamadaTime = new Date(lead.llamada_at).getTime()
  if (isNaN(llamadaTime)) {
    return { candidate: false, reason: 'llamada_at inválido' }
  }
  // La llamada debe ser en el futuro (al menos 5 min adelante)
  if (llamadaTime < Date.now() + 5 * 60_000) {
    return { candidate: false, reason: 'llamada ya pasó o es en menos de 5 min' }
  }
  if (!lead.telefono) {
    return { candidate: false, reason: 'lead sin teléfono — Dapta no puede llamar' }
  }
  return {
    candidate: true,
    reason: `${bucket === 'hot' ? '🔥' : bucket} (${score} pts) · llamada agendada ${new Date(llamadaTime).toLocaleString('es-MX')}`,
  }
}

/** Calcula la expiración natural de una aprobación. */
export function defaultExpiresAt(tipo: AprobacionTipo, lead: Lead): string | null {
  if (tipo === 'vambe_template') {
    // Vambe outbound: si pasan 6 horas y no aprobaste, ya no tiene sentido
    return new Date(Date.now() + 6 * 60 * 60_000).toISOString()
  }
  if (tipo === 'dapta_call') {
    // Dapta: expira a la hora de la llamada
    return lead.llamada_at || null
  }
  return null
}
