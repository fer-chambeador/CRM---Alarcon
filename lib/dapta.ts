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
// IMPORTANTE: Daniela (Dapta, RetellAI-backed) envía TODO bajo `call.*`. Es decir
// `call_analysis`, `dynamic_variables` (con nuestro lead_id), `to_number`, etc.
// NO viene `event` ni `data` en raíz — eso era un mito de la doc HubSpot.
//
// Shape real observado en run de Flow B "Post-Call to CRM" (31/05/2026):
//
// {
//   "call": {
//     "call_id": "call_4604731cb42540...",
//     "call_type": "phone_call",
//     "agent_id": "agent_7c6563f4520cd...",
//     "agent_version": 0,
//     "agent_name": "Daniela - Sales AI",
//     "call_status": "ended",                          // ended | no_answer | voicemail | ...
//     "start_timestamp": 1780207957513,                // epoch MS, no ISO
//     "end_timestamp":   1780208128854,
//     "duration_ms": 171341,
//     "total_duration_seconds": 171.3,
//     "transcript": "Agent: Hola...\nUser: Hola...\n", // texto plano
//     "transcript_object": [{ role, content, words: [...] }],
//     "recording_url": "https://...",
//     "from_number": "+525543604918",
//     "to_number":   "+525517282187",
//     "direction": "outbound",
//     "twilio_call_sid": "...",
//     "disconnection_reason": "User Hangup",
//     "user_sentiment": "Positive",
//     "call_successful": true,
//     "call_analysis": {
//       "call_summary": "...",
//       "user_sentiment": "Positive",
//       "call_successful": true,
//       "in_voicemail": false,
//       "custom_analysis_data": {
//         "outcome": "pidio_link_pago",
//         "interes_real": "alto",
//         "proximo_paso": "...",
//         "puesto_buscado": "...",
//         "zona_ubicacion": "...",
//         "presupuesto_paquete": "una_publicacion",
//         "usa_otra_plataforma": "...",
//         "objeciones": "...",
//         "agendar_seguimiento": "...",
//         "sentimiento": "positivo"
//       }
//     },
//     "dynamic_variables": {                           // ← nuestros params del trigger
//       "lead_id": "uuid-del-lead",
//       "nombre": "...",
//       "empresa": "...",
//       "vacante": "...",
//       "presupuesto": "...",
//       "puesto": "...",
//       "notas": "..."
//     },
//     "cost": { ... },
//     "credits_consumed": 999
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

export type DaptaCallObject = {
  call_id?: string
  call_type?: string
  agent_id?: string
  agent_version?: number
  agent_name?: string
  call_status?: string                  // 'ended' | 'no_answer' | 'voicemail' | 'failed' | ...
  status?: string                       // backup, por si Dapta cambia el nombre
  to_number?: string
  from_number?: string
  direction?: string
  start_timestamp?: number              // epoch MS
  end_timestamp?: number                // epoch MS
  started_at?: string                   // ISO (fallback)
  ended_at?: string                     // ISO (fallback)
  duration_ms?: number
  total_duration_seconds?: number
  duration_seconds?: number             // backup
  duration?: number                     // backup
  recording_url?: string
  transcript?: string | Array<{ role?: string; speaker?: string; content?: string; text?: string }>
  transcript_object?: Array<{ role?: string; content?: string; words?: unknown[] }>
  disconnection_reason?: string
  user_sentiment?: string
  call_successful?: boolean
  call_analysis?: {
    call_summary?: string
    user_sentiment?: string
    call_successful?: boolean
    in_voicemail?: boolean
    custom_analysis_data?: DaptaCustomAnalysis
    [k: string]: unknown
  }
  dynamic_variables?: {
    lead_id?: string
    nombre?: string
    empresa?: string
    vacante?: string
    presupuesto?: string
    puesto?: string
    notas?: string
    [k: string]: unknown
  }
  cost?: unknown
  credits_consumed?: number
  [k: string]: unknown
}

export type DaptaPostCallPayload = {
  // El shape REAL es { call: {...todo...} }, pero aceptamos los legados por si
  // algún día Dapta o un proxy nos manda con estructura distinta.
  call?: DaptaCallObject
  event?: string
  call_analysis?: DaptaCallObject['call_analysis']  // legacy, si viene en raíz
  data?: { lead_id?: string; [k: string]: unknown } // legacy
  // Acepta también shape "flat" — todo en raíz (algunos webhooks lo hacen)
  call_id?: string
  to_number?: string
  from_number?: string
  duration_ms?: number
  total_duration_seconds?: number
  [k: string]: unknown
}

/**
 * Normaliza un payload Dapta a una forma estándar consumible por el handler.
 *
 * Acepta tres variantes:
 *   - Shape oficial Daniela: `{ call: {...todo, call_analysis, dynamic_variables} }`
 *   - Shape legado HubSpot:  `{ event, call, call_analysis, data: { lead_id } }`
 *   - Shape flat:            `{ call_id, to_number, ... }` (raíz)
 *
 * Devuelve los campos ya extraídos — el handler los consume sin lógica condicional.
 */
export function extractPostCallFields(payload: DaptaPostCallPayload): {
  callId: string | null
  agentId: string | null
  agentName: string | null
  toNumber: string | null
  fromNumber: string | null
  rawStatus: string | null
  durationSeconds: number | null
  startedAtIso: string | null
  endedAtIso: string | null
  recordingUrl: string | null
  transcript: unknown
  summary: string | null
  customAnalysis: DaptaCustomAnalysis
  leadIdFromPayload: string | null
  userSentiment: string | null
} {
  // Si viene wrapped en `call`, usamos eso; sino el payload mismo es el call.
  const c: DaptaCallObject = (payload.call as DaptaCallObject) || (payload as DaptaCallObject)

  // Status: puede venir como call_status (Daniela) o status (legado)
  const rawStatus = c.call_status || c.status || (payload as { status?: string }).status || null

  // Duración: priorizar duration_ms (ms) → segundos. Si no, total_duration_seconds.
  // Validamos >= 0 — si Dapta manda un valor negativo (raro pero posible),
  // lo tratamos como ausente para evitar persistir basura en DB.
  let durationSeconds: number | null = null
  if (typeof c.duration_ms === 'number' && c.duration_ms >= 0) durationSeconds = Math.round(c.duration_ms / 1000)
  else if (typeof c.total_duration_seconds === 'number' && c.total_duration_seconds >= 0) durationSeconds = Math.round(c.total_duration_seconds)
  else if (typeof c.duration_seconds === 'number' && c.duration_seconds >= 0) durationSeconds = c.duration_seconds
  else if (typeof c.duration === 'number' && c.duration >= 0) durationSeconds = c.duration

  // Started/Ended: epoch MS → ISO si están como number, sino usar ISO directo.
  const startedAtIso: string | null = typeof c.start_timestamp === 'number'
    ? new Date(c.start_timestamp).toISOString()
    : (c.started_at || null)
  const endedAtIso: string | null = typeof c.end_timestamp === 'number'
    ? new Date(c.end_timestamp).toISOString()
    : (c.ended_at || null)

  // call_analysis puede venir DENTRO de call (Daniela) o en raíz (legado)
  const analysis = c.call_analysis || payload.call_analysis || {}
  const rawCustom = (analysis.custom_analysis_data || {}) as DaptaCustomAnalysis
  // Daniela mete strings "null"/"undefined" en campos opcionales que rompen
  // queries downstream y renders en UI. Limpiamos TODO el objeto antes de persist.
  const customAnalysis: DaptaCustomAnalysis = {}
  for (const k of Object.keys(rawCustom)) {
    const v = rawCustom[k]
    if (typeof v === 'string') {
      const cleaned = cleanNullString(v)
      if (cleaned !== null) customAnalysis[k] = cleaned
    } else if (v !== null && v !== undefined) {
      customAnalysis[k] = v
    }
  }
  const summary = cleanNullString(analysis.call_summary) || cleanNullString(customAnalysis.resumen_detallado as string) || null

  // lead_id: prioridad — dynamic_variables (real Daniela) > data.lead_id (legado)
  const leadIdFromPayload =
    (c.dynamic_variables?.lead_id as string | undefined) ||
    (payload.data?.lead_id as string | undefined) ||
    null

  return {
    callId: c.call_id || (payload as { call_id?: string }).call_id || null,
    agentId: c.agent_id || null,
    agentName: c.agent_name || null,
    toNumber: c.to_number || (payload as { to_number?: string }).to_number || null,
    fromNumber: c.from_number || (payload as { from_number?: string }).from_number || null,
    rawStatus,
    durationSeconds,
    startedAtIso,
    endedAtIso,
    recordingUrl: c.recording_url || null,
    // Limitar transcript a 200KB para evitar romper la columna en DB con calls
    // muy largas (Daniela puede generar transcripts de >1MB en calls de 30min).
    transcript: (() => {
      const t = c.transcript_object || c.transcript || null
      if (!t) return null
      const serialized = typeof t === 'string' ? t : JSON.stringify(t)
      if (serialized.length > 200_000) {
        console.warn(`[dapta] transcript truncado de ${serialized.length} a 200KB para call ${c.call_id}`)
        return serialized.slice(0, 200_000) + '...[truncado]'
      }
      return t
    })(),
    summary,
    customAnalysis,
    leadIdFromPayload,
    userSentiment: c.user_sentiment || analysis.user_sentiment || null,
  }
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
/**
 * Daniela mete strings "null" en campos que deberían ser null real cuando no
 * extrae info útil (ej. agendar_seguimiento: "null" como string). Esto rompe
 * inserts en columnas timestamp/date. Limpiamos aquí.
 */
function cleanNullString(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined' || s === 'n/a') return null
  return s
}

export function deriveAccionables(custom: DaptaCustomAnalysis | null | undefined): {
  pidio_link_pago: boolean
  pidio_presentacion: boolean
  agendar_seguimiento: string | null
} {
  const out = (custom?.outcome || '').toLowerCase()
  const raw = cleanNullString(custom?.agendar_seguimiento)
  // Validar que sea una fecha parseable; si no, devolver null para no romper DB
  let agendar: string | null = null
  if (raw) {
    const d = new Date(raw)
    if (!isNaN(d.getTime())) agendar = d.toISOString()
  }
  return {
    pidio_link_pago: out === 'pidio_link_pago',
    pidio_presentacion: out === 'pidio_presentacion',
    agendar_seguimiento: agendar,
  }
}
