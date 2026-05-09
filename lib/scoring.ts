import type { Lead } from './supabase'
import { phoneToState } from './lada'

/**
 * Heurística de calificación 0–100 (v2).
 *
 * Pesos:
 *   Presupuesto (25)  — entre mayor budget, mejor.
 *   Canal (20)        — Recomendación e Inbound (vio CVs) son los más calientes;
 *                       canales nuevos / desconocidos > RRSS (saturadas).
 *   Estado (10)       — CDMX y Estado de México tienen prioridad.
 *   Rol en empresa (15) — dueño / fundador > gerente de RH > otros gerentes.
 *   Vacante (15)      — roles "generales" (volumen, fáciles de reclutar)
 *                       > especializados (mecánico, ingeniero, contador, etc.).
 *   Correo corporativo (10) — domain ≠ gmail/hotmail/yahoo/etc.
 *   Engagement (5)    — empresa registrada y/o ya contactado al menos una vez.
 *
 * Buckets (no cambian): hot ≥60, warm ≥30, cold <30.
 */

const PRESUPUESTO_POINTS: Record<string, number> = {
  none: 0,
  '100_to_1000': 8,
  '2000_to_5000': 17,
  '10000_plus': 25,
}

// Heurística para canal — usamos regex sobre lower-case para tolerar variantes
function canalPoints(canal: string | null): number {
  if (!canal) return 0
  const c = canal.toLowerCase()
  if (/recomenda|referral/.test(c)) return 20
  if (/inbound|cv|chambas/.test(c)) return 18  // "vio CVs de chambas" cae acá
  if (/instagram|facebook|tiktok|linkedin|\big\b|\bfb\b/.test(c)) return 8  // RRSS — saturadas
  return 12  // canal nuevo / desconocido / otro
}

// CDMX y Estado de México son el bullseye geográfico
function estadoPoints(estado: string | null): number {
  if (!estado) return 0
  const e = estado.toLowerCase()
  if (/cdmx|ciudad de m[ée]xico|distrito federal/.test(e)) return 10
  if (/estado de m[ée]xico|edomex/.test(e)) return 10
  return 0
}

// Rol en su empresa (decision maker)
function rolEmpresaPoints(p: string | null): number {
  if (!p) return 0
  const s = p.toLowerCase()
  if (/(due[ñn]|ceo|director|socio|fundador|owner|presidente)/.test(s)) return 15
  if (/(reclut|recursos hum|talent)/.test(s) || /\brh\b/.test(s)) return 12
  if (/(gerente|manager|head|jefe)/.test(s)) return 8
  return 4
}

// Vacante (puesto que el cliente quiere reclutar) — más "general" = mejor
const VACANTE_GENERAL = /(general|ayudante|operario|operador|almacen|mozo|cargador|mensajer|limpieza|auxiliar|empacador|cajer|repartidor|chofer|seguridad|vigilante|recepcionista|asistente|montacarg|despacho|inventario|estibador|paquetero|merma|conserje|jardiner|pintor)/i

const VACANTE_ESPECIALIZADA = /(ingenier|t[ée]cnico|especialista|supervisor|contador|abogad|m[ée]dico|enfermer|programador|desarroll|dise[ñn]ador|mec[áa]nico|electricista|plomer|soldador|arquitect|consultor|analista|director|farmac|qu[íi]mic|veterinari|odontolog|psicolog|maestro|profesor|chef\b)/i

function vacantePoints(v: string | null): number {
  if (!v) return 0
  if (VACANTE_GENERAL.test(v)) return 15
  if (VACANTE_ESPECIALIZADA.test(v)) return 6
  return 10  // sin clasificar — neutro tirando a alto
}

// Email corporativo: dominio que NO es de proveedor masivo de email gratis
const CONSUMER_EMAIL_DOMAINS = /@(gmail|hotmail|yahoo|outlook|icloud|me|live|aol|protonmail|proton|msn|googlemail|inbox|zoho|gmx|tutanota|mail)\./i

function emailCorporativoPoints(email: string | null): number {
  if (!email) return 0
  if (CONSUMER_EMAIL_DOMAINS.test(email)) return 0
  return /@[\w.-]+\.\w+/.test(email) ? 10 : 0
}

function engagementPoints(lead: Lead): number {
  let s = 0
  if (lead.empresa) s += 2
  if ((lead.veces_contactado || 0) >= 1) s += 3
  return s
}

export function leadScore(lead: Lead): number {
  let score = 0

  if (lead.presupuesto) score += PRESUPUESTO_POINTS[lead.presupuesto] ?? 0
  score += canalPoints(lead.canal_adquisicion)
  score += estadoPoints(lead.estado || phoneToState(lead.telefono))
  score += rolEmpresaPoints(lead.puesto)
  score += vacantePoints(lead.vacante)
  score += emailCorporativoPoints(lead.email)
  score += engagementPoints(lead)

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

/**
 * Breakdown por categoría — útil para tooltip "por qué este score".
 */
export function leadScoreBreakdown(lead: Lead) {
  return {
    presupuesto: lead.presupuesto ? PRESUPUESTO_POINTS[lead.presupuesto] ?? 0 : 0,
    canal: canalPoints(lead.canal_adquisicion),
    estado: estadoPoints(lead.estado || phoneToState(lead.telefono)),
    rolEmpresa: rolEmpresaPoints(lead.puesto),
    vacante: vacantePoints(lead.vacante),
    correoCorporativo: emailCorporativoPoints(lead.email),
    engagement: engagementPoints(lead),
  }
}
