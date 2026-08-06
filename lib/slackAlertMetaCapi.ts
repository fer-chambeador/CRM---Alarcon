import type { Lead } from './supabase'

/**
 * Alerta a Slack por cada evento enviado a Meta CAPI.
 *
 * A diferencia de las otras alertas del CRM (incoming webhooks con canal
 * fijo), esta postea a un canal por ID vía chat.postMessage con el
 * SLACK_BOT_TOKEN — así el canal destino se cambia sin crear webhooks.
 *
 * Env vars:
 *  - SLACK_BOT_TOKEN              (ya existe — el bot del CRM)
 *  - SLACK_META_CAPI_CHANNEL_ID   (opcional; default el canal de eventos CAPI)
 *
 * Requisitos del bot en Slack: scope `chat:write` y estar invitado al canal
 * (`/invite @bot`). Best-effort: si falla solo loguea, nunca rompe el cron.
 */

const DEFAULT_CHANNEL = 'C0B84JMD22U'

export async function alertMetaCapiEvent(params: {
  lead: Lead
  eventName: string
  eventId: string
  datasetId: string
  customData: Record<string, unknown>
  eventsReceived: number
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    console.warn('[meta-capi] SLACK_BOT_TOKEN no configurado — skip alerta Slack')
    return
  }
  const channel = process.env.SLACK_META_CAPI_CHANNEL_ID || DEFAULT_CHANNEL
  const { lead } = params

  const usuario = [lead.nombre || 'NA', lead.empresa || 'NA', lead.telefono || 'NA'].join(' / ')
  const text = [
    `*${params.eventName} enviado a Meta CAPI*`,
    `Usuario: ${usuario}`,
    `event_id: ${params.eventId}`,
    `dataset: ${params.datasetId}`,
    `custom_data: ${JSON.stringify(params.customData)}`,
    `recibidos: ${params.eventsReceived}`,
  ].join('\n')

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text }),
    })
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null
    if (!json?.ok) {
      // Errores típicos: missing_scope (falta chat:write), not_in_channel
      // (falta /invite al bot), channel_not_found.
      console.error('[meta-capi] alerta Slack falló', json?.error || `HTTP ${res.status}`)
    }
  } catch (e) {
    console.error('[meta-capi] alerta Slack error', e instanceof Error ? e.message : e)
  }
}
