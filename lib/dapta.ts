/**
 * Dapta AI integration — helpers para disparar llamadas y parsear webhooks post-call.
 *
 * Dapta no expone una API REST directa para "disparar llamada"; el patrón oficial
 * es crear un Flow Studio Flow con webhook trigger que internamente usa el nodo
 * "Dapta Phone Call". Nosotros le hacemos POST al webhook trigger.
 *
 * Env vars:
 *   - DAPTA_TRIGGER_WEBHOOK_URL   (obligatoria) URL pública del Flow A
 *   - DAPTA_POST_CALL_SECRET      (obligatoria) secret que validamos en /api/dapta/post-call
 *   - DAPTA_AGENT_NAME_DEFAULT    (opcional)   nombre legible del agente — solo para UI
 *   - DAPTA_FROM_NUMBER           (opcional)   número verificado en Dapta (solo display)
 *   - NEXT_PUBLIC_CRM_URL         (opcional)   base URL del CRM para deep links
 */

import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

export type DaptaTriggerPayload = {
  // Identifica el lead en NUESTRO CRM (lo recibimos de vuelta en el post-call para correlate)
  lead_id: string
  // Número del cliente (E.164, +52XXXXXXXXXX)
  to_number: string
  // Contexto del lead que el agente va a usar como variables {{trigger.body.X}}
  nombre?: string | null
  empresa?: string | null
  vacante?: string | null
  presupuesto?: string | null
  puesto?: string | null
  notas?: string | null
  // URL del CRM para que el agente la mencione si necesita (no obligatorio)
  crm_url?: string
}

export type DaptaTriggerResult = {
  ok: boolean
  status?: number
  body?: unknown
  error?: string
}

/**
 * Dispara la llamada: POST al Flow A de Dapta.
 *
 * El Flow A debe estar configurado con un Webhook Trigger (POST) y un nodo
 * "Dapta Phone Call" que mapea `{{trigger.body.to_number}}`, `{{trigger.body.nombre}}`, etc.
 */
export async function triggerDaptaCall(payload: DaptaTriggerPayload): Promise<DaptaTriggerResult> {
  const url = process.env.DAPTA_TRIGGER_WEBHOOK_URL
  if (!url) return { ok: false, error: 'DAPTA_TRIGGER_WEBHOOK_URL no configurada' }

  const normalized = normalizeMexicanPhone(payload.to_number) || payload.to_number
  const body = {
    ...payload,
    to_number: normalized,
    crm_url: payload.crm_url || process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app',
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: unknown = text
    try { parsed = JSON.parse(text) } catch { /* keep as text */ }
    if (!res.ok) {
      return { ok: false, status: res.status, body: parsed, error: `Dapta trigger HTTP ${res.status}` }
    }
    return { ok: true, status: res.status, body: parsed }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── Post-call payload shape ─────────────────────────────────────────────────
//
// Dapta envía POST a nuestro webhook con esta forma (basado en el docs HubSpot
// y el patrón {{trigger.body.call}}):
//
// {
//   "event": "call.completed" | "call.failed" | etc.,
//   "call": {
//     "call_id": "...",
//     "agent_id": "...",
//     "agent_name": "Daniela",
//     "to_number": "+52...",
//     "from_number": "+52...",
//     "status": "completed" | "no_answer" | "voicemail" | "failed",
//     "duration": 240,                              // segundos
//     "started_at": "2026-05-31T10:30:00Z",
//     "ended_at":   "2026-05-31T10:34:00Z",
//     "recording_url": "https://...",
//     "transcript": [{ "speaker": "agent", "text": "Hola Lic..." }, ...]
//   },
//   "call_analysis": {
//     "call_summary": "...",
//     "custom_analysis_data": {
//       "outcome": "pidio_link_pago",
//       "puesto_buscado": "meseros",
//       "zona_ubicacion": "Roma Norte",
//       ...
//     }
//   },
//   "data": {
//     // payload original que mandamos al trigger (Dapta lo reenvía)
//     "lead_id": "uuid-del-lead-en-CRM"
//   }
// }

export type DaptaCallStatus =
  | 'queued' | 'dialing' | 'connected' | 'completed'
  | 'failed' | 'no_answer' | 'voicemail' | 'canceled'

export type DaptaCustomAnalysis = {
  outcome?: 'pidio_link_pago' | 'pidio_presentacion' | 'no_interesado' | 'callback' | 'buzon_voz' | 'numero_equivocado' | 'otro' | null
  puesto_buscado?: string | null
  zona_ubicacion?: string | null
  presupuesto_paquete?: 'una_publicacion' | 'paquete_5' | 'paquete_12' | 'mas_grande' | 'no_definido' | null
  objeciones?: string[] | null
  usa_otra_plataforma?: string | null
  interes_real?: 'alto' | 'medio' | 'bajo' | null
  proximo_paso?: string | null
  resumen_detallado?: string | null
  agendar_seguimiento?: string | null      // ISO 8601
  sentimiento?: 'positivo' | 'neutral' | 'negativo' | null
  [k: string]: unknown
}

export type DaptaPostCallPayload = {
  event?: string
  call?: {
    call_id?: string
    agent_id?: string
    agent_name?: string
    to_number?: string
    from_number?: string
    status?: string
    duration?: number
    duration_seconds?: number
    started_at?: string
    ended_at?: string
    recording_url?: string
    transcript?: Array<{ speaker?: string; text?: string; timestamp?: string }>
    [k: string]: unknown
  }
  call_analysis?: {
    call_summary?: string
    custom_analysis_data?: DaptaCustomAnalysis
    [k: string]: unknown
  }
  data?: {
    lead_id?: string
    [k: string]: unknown
  }
  [k: string]: unknown
}

/**
 * Normaliza el status Dapta a nuestro enum interno.
 */
export function normalizeDaptaStatus(raw: string | undefined | null): DaptaCallStatus {
  const s = (raw || '').toLowerCase().trim()
  if (!s) return 'completed'
  if (s.includes('voicemail') || s.includes('buzon')) return 'voicemail'
  if (s.includes('no_answer') || s.includes('no answer') || s.includes('no-answer') || s.includes('busy')) return 'no_answer'
  if (s.includes('fail') || s.includes('error')) return 'failed'
  if (s.includes('cancel')) return 'canceled'
  if (s.includes('queue')) return 'queued'
  if (s.includes('dial') || s.includes('ringing')) return 'dialing'
  if (s.includes('connect') || s.includes('in-progress') || s.includes('ongoing')) return 'connected'
  if (s.includes('complete') || s.includes('ended') || s.includes('finish')) return 'completed'
  return 'completed'
}

/**
 * Deriva flags de accionables a partir del custom_analysis.
 * Si el agente respondió `outcome: 'pidio_link_pago'`, marcamos el flag aunque
 * el campo dedicado no esté presente — la UI y las alertas Slack leen estos flags.
 */
export function deriveAccionables(custom: DaptaCustomAnalysis | null | undefined): {
  pidio_link_pago: boolean
  pidio_presentacion: boolean
  agendar_seguimiento: string | null
} {
  const out = (custom?.outcome || '').toLowerCase()
  return {
    pidio_link_pago: out === 'pidio_link_pago',
    pidio_presentacion: out === 'pidio_presentacion',
    agendar_seguimiento: custom?.agendar_seguimiento || null,
  }
}
