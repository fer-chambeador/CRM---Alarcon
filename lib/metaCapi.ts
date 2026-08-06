import { createHash } from 'crypto'
import type { Lead } from './supabase'
import { normalizeMexicanPhone } from './phoneNormalize'
import { captureException } from './errorTracking'

/**
 * Meta Conversions API (CAPI) — nutre el Pixel/dataset de Meta con el evento
 * estándar "Schedule" cuando un lead llega a status `llamada_agendada`.
 *
 * El envío NO se hace inline en los sitios que escriben el status (hay 8+):
 * el cron /api/cron/meta-capi barre cada 10 min los leads agendados sin
 * evento enviado (columna leads.meta_capi_schedule_sent_at) y llama
 * sendScheduleEvent(). Un solo punto de enganche, cubre caminos futuros.
 *
 * Docs: https://developers.facebook.com/docs/marketing-api/conversions-api
 *
 * Env vars:
 *  - META_CAPI_PIXEL_ID         (dataset/pixel ID, Events Manager)
 *  - META_CAPI_ACCESS_TOKEN     (Events Manager → Configuración → Conversions API → Generate token)
 *  - META_CAPI_TEST_EVENT_CODE  (opcional — tab Test Events; quitar en prod)
 */

const GRAPH_URL = 'https://graph.facebook.com/v23.0'

export function isMetaCapiConfigured(): boolean {
  return Boolean(process.env.META_CAPI_PIXEL_ID && process.env.META_CAPI_ACCESS_TOKEN)
}

export type MetaCapiResult =
  | { ok: true; events_received: number; fbtrace_id?: string }
  // unmatchable = el lead no tiene email ni teléfono utilizables — reintentar
  // nunca va a servir; el cron lo marca como enviado con actividad de skip.
  | { ok: false; error: string; unmatchable?: boolean }

// Emails inventados por el CRM para leads sin email real. Mandarlos a Meta
// contaminaría el matching (dominios que no existen en ninguna cuenta real).
const PLACEHOLDER_EMAIL_DOMAINS = ['@clientes.chambas.ai', '@whatsapp.chambas.ai']

function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true
  const e = email.trim().toLowerCase()
  return PLACEHOLDER_EMAIL_DOMAINS.some(d => e.endsWith(d))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * user_data con hashing SHA-256 según la normalización que exige Meta
 * (email lowercase; teléfono en E.164 sin "+"; nombres lowercase).
 * Devuelve null si no queda ni email ni teléfono — un evento solo con
 * nombre no matchea a nadie y solo baja el Event Match Quality.
 */
function buildUserData(lead: Lead): Record<string, unknown> | null {
  const userData: Record<string, unknown> = {}

  if (!isPlaceholderEmail(lead.email)) {
    userData.em = [sha256(lead.email.trim().toLowerCase())]
  }
  const phone = normalizeMexicanPhone(lead.telefono)
  if (phone) {
    userData.ph = [sha256(phone.replace(/\D/g, ''))]
  }
  if (!userData.em && !userData.ph) return null

  const nombre = (lead.nombre || '').trim().toLowerCase()
  if (nombre) {
    const [fn, ...rest] = nombre.split(/\s+/)
    userData.fn = [sha256(fn)]
    if (rest.length > 0) userData.ln = [sha256(rest.join(' '))]
  }
  userData.external_id = [sha256(lead.id)]
  // ctwa_clid va CRUDO (sin hash) — es el click ID del ad Click-to-WhatsApp.
  if (lead.ctwa_clid) userData.ctwa_clid = lead.ctwa_clid
  return userData
}

/**
 * Manda el evento "Schedule" a Meta CAPI para un lead que llegó a
 * llamada_agendada. Best-effort: nunca lanza. La idempotencia (una vez por
 * lead) vive en el cron vía leads.meta_capi_schedule_sent_at; además el
 * event_id determinístico hace que Meta deduplique reintentos (ventana 48h)
 * y un eventual Pixel del sitio con el mismo id.
 */
export async function sendScheduleEvent(lead: Lead): Promise<MetaCapiResult> {
  try {
    const pixelId = process.env.META_CAPI_PIXEL_ID
    const token = process.env.META_CAPI_ACCESS_TOKEN
    if (!pixelId || !token) {
      return { ok: false, error: 'META_CAPI_PIXEL_ID / META_CAPI_ACCESS_TOKEN no configuradas' }
    }

    const userData = buildUserData(lead)
    if (!userData) {
      return { ok: false, error: 'sin user_data matcheable (email placeholder y sin teléfono)', unmatchable: true }
    }

    // Momento real del cambio de status, clampeado a la ventana de 7 días
    // que acepta Meta (por si el sweep procesa un lead rezagado).
    const nowSec = Math.floor(Date.now() / 1000)
    const changedSec = Math.floor(new Date(lead.status_changed_at || lead.created_at).getTime() / 1000)
    const eventTime = Math.min(nowSec, Math.max(changedSec, nowSec - 7 * 24 * 3600 + 3600))

    // business_messaging exige ctwa_clid; sin él (leads manuales, o mientras
    // Vambe no reenvíe el referral) el evento sale como system_generated.
    const event: Record<string, unknown> = {
      event_name: 'Schedule',
      event_time: eventTime,
      event_id: `schedule-${lead.id}`,
      action_source: lead.ctwa_clid ? 'business_messaging' : 'system_generated',
      user_data: userData,
      custom_data: {
        currency: 'MXN',
        value: lead.monto || 0,
        canal_adquisicion: lead.canal_adquisicion || 'desconocido',
        lead_source: lead.vambe_contact_id ? 'vambe' : lead.google_calendar_event_id ? 'calendar' : 'manual',
        ...(lead.fb_ad_id ? { fb_ad_id: lead.fb_ad_id } : {}),
      },
    }
    if (lead.ctwa_clid) event.messaging_channel = 'whatsapp'

    const body: Record<string, unknown> = { data: [event] }
    if (process.env.META_CAPI_TEST_EVENT_CODE) {
      body.test_event_code = process.env.META_CAPI_TEST_EVENT_CODE
    }

    const res = await fetch(`${GRAPH_URL}/${pixelId}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const json = await res.json().catch(() => null) as
      { events_received?: number; fbtrace_id?: string; error?: { message?: string } } | null
    if (!res.ok) {
      return { ok: false, error: json?.error?.message || `Meta CAPI HTTP ${res.status}` }
    }
    return { ok: true, events_received: json?.events_received ?? 0, fbtrace_id: json?.fbtrace_id }
  } catch (e) {
    captureException(e, { context: 'meta-capi sendScheduleEvent', lead_id: lead.id })
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── Atribución CTWA desde webhooks de Vambe ────────────────────────────

export type MetaAttribution = {
  ctwa_clid?: string
  fb_ad_id?: string
  fb_source_url?: string
}

/**
 * Busca el objeto `referral` de WhatsApp (ads Click-to-WhatsApp) dentro de un
 * payload de webhook de Vambe. Defensivo a propósito: la doc pública de Vambe
 * hoy NO incluye el referral, así que probamos las rutas donde podría aparecer
 * cuando lo agreguen (referral suelto, anidado en payload/message/contact, o
 * estilo context.ad de otros proveedores).
 */
export function extractMetaAttribution(data: Record<string, unknown>): MetaAttribution | null {
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null

  const payload = asObj(data.payload)
  const context = asObj(data.context) || asObj(payload?.context)

  // Contenedores que son explícitamente el referral/ad — cualquier campo cuenta.
  const explicit = [
    asObj(data.referral), asObj(payload?.referral),
    asObj(asObj(data.message)?.referral), asObj(asObj(payload?.message)?.referral),
    asObj(asObj(data.contact)?.referral),
    asObj((asObj(data.ai_contact) || asObj(data.aiContact))?.referral),
    asObj(context?.ad),
  ].filter(Boolean) as Record<string, unknown>[]

  const pick = (obj: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }

  const fromContainer = (obj: Record<string, unknown>): MetaAttribution | null => {
    const attr: MetaAttribution = {}
    const ctwa = pick(obj, ['ctwa_clid', 'ctwaClid', 'ctwa'])
    const adId = pick(obj, ['source_id', 'sourceId', 'ad_id', 'adId'])
    const sourceUrl = pick(obj, ['source_url', 'sourceUrl', 'ad_url', 'adUrl'])
    if (ctwa) attr.ctwa_clid = ctwa
    if (adId) attr.fb_ad_id = adId
    if (sourceUrl) attr.fb_source_url = sourceUrl
    return Object.keys(attr).length > 0 ? attr : null
  }

  for (const container of explicit) {
    const attr = fromContainer(container)
    if (attr) return attr
  }

  // Contenedores sueltos (el evento mismo): solo si trae ctwa_clid explícito —
  // source_id/id a este nivel significan otra cosa (message id, stage id, etc).
  for (const loose of [data, payload].filter(Boolean) as Record<string, unknown>[]) {
    if (pick(loose, ['ctwa_clid', 'ctwaClid'])) {
      const attr = fromContainer(loose)
      if (attr) return attr
    }
  }
  return null
}
