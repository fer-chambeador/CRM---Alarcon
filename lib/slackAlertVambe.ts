/**
 * Slack alerts específicos para eventos de Vambe que requieren acción humana.
 *
 * Canal dedicado: #alertas-vambe (env: SLACK_ALERTAS_VAMBE_WEBHOOK_URL).
 * Si no está configurado, fallback a SLACK_ALERT_WEBHOOK_URL.
 *
 * Eventos cubiertos:
 *   1. Asistencia Humana — lead pasó al stage donde Vambe pide intervención.
 *      Mensaje incluye: Nombre, Número, resumen del último mensaje del cliente,
 *      y un botón "✓ Atendido" que linkea a /api/atencion/[ticket_id]/attend
 *      para que el user confirme que ya lo trabajó.
 */

import type { Lead } from '@/lib/supabase'

/**
 * Webhook resolution con fallback chain:
 *  1. SLACK_ALERTAS_VAMBE_WEBHOOK_URL  (recomendado — canal #alertas-vambe)
 *  2. SLACK_ALERT_WEBHOOK_URL          (canal default)
 *  3. SLACK_LLAMADAS_WEBHOOK_URL       (último resort — usa el canal de llamadas
 *                                        para que la alerta NO se pierda silente)
 */
function alertasVambeWebhook(): string | undefined {
  return process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL
    || process.env.SLACK_ALERT_WEBHOOK_URL
    || process.env.SLACK_LLAMADAS_WEBHOOK_URL
}

function crmBaseUrl(): string {
  return process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
}

/**
 * Genera un resumen corto de qué necesita el lead, basado en su último mensaje
 * y el contexto (vacante, presupuesto, empresa).
 *
 * Esto es heurístico — no requiere LLM. Si en el futuro quieres calidad LLM,
 * cambiarlo a Anthropic call con Haiku.
 */
export function summarizeNeed(lastMessage: string | null, lead: Pick<Lead, 'vacante' | 'empresa' | 'presupuesto'>): string {
  const msg = (lastMessage || '').trim()
  if (msg) {
    // Si el mensaje del cliente es corto (≤180 chars), usarlo tal cual
    if (msg.length <= 180) return msg
    // Sino, truncar inteligente: primera oración o primeros 180 chars
    const firstSentence = msg.split(/[.!?]\s/)[0]
    if (firstSentence.length <= 200) return firstSentence + (firstSentence !== msg ? '…' : '')
    return msg.slice(0, 180) + '…'
  }
  // Fallback si no tenemos último mensaje
  const parts: string[] = []
  if (lead.vacante) parts.push(`Necesita reclutar: ${lead.vacante}`)
  if (lead.empresa) parts.push(`Empresa: ${lead.empresa}`)
  if (lead.presupuesto) parts.push(`Presupuesto: ${lead.presupuesto}`)
  return parts.length ? parts.join(' · ') : '(no hay contexto del mensaje)'
}

/**
 * Manda alerta a #alertas-vambe usando Block Kit con botón link "Atendido".
 * Vuelve { ts, channel } si Slack respondió OK con el message timestamp
 * (útil para luego editar el mensaje cuando alguien marca "atendido").
 *
 * Implementación: usamos Incoming Webhook que NO devuelve ts. Por eso el
 * botón es un LINK que apunta a nuestro endpoint /api/atencion/[id]/attend
 * — al hacer click, el user llega a una página de confirmación que marca
 * el ticket como atendido y muestra "✓ Atendido por <vos>".
 */
export async function alertAtencionHumanaVambe(params: {
  ticketId: string
  lead: Pick<Lead, 'id' | 'nombre' | 'email' | 'telefono' | 'empresa' | 'vacante' | 'presupuesto'>
  lastMessage: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const webhookUrl = alertasVambeWebhook()
  if (!webhookUrl) {
    console.warn('SLACK_ALERTAS_VAMBE_WEBHOOK_URL no configurado — skip alerta')
    return { ok: false, error: 'no-webhook' }
  }

  const { ticketId, lead, lastMessage } = params
  const resumen = summarizeNeed(lastMessage, lead)
  const attendUrl = `${crmBaseUrl()}/api/atencion/${ticketId}/attend?via=slack`
  const dismissUrl = `${crmBaseUrl()}/api/atencion/${ticketId}/dismiss?via=slack`
  const leadUrl = `${crmBaseUrl()}/leads/${lead.id}`

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🆘 Lead necesita asistencia manual', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Nombre:*\n${lead.nombre || lead.email || '(sin nombre)'}` },
        { type: 'mrkdwn', text: `*Número:*\n${lead.telefono || '—'}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*¿Qué necesita?*\n${resumen}` },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${lead.empresa ? `🏢 ${lead.empresa}` : ''}${lead.empresa && lead.vacante ? ' · ' : ''}${lead.vacante ? `💼 ${lead.vacante}` : ''}${lead.presupuesto ? ` · 💵 ${lead.presupuesto}` : ''}` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✓ Sí, atendido', emoji: true },
          style: 'primary',
          url: attendUrl,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✗ No relevante', emoji: true },
          url: dismissUrl,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Ver lead', emoji: true },
          url: leadUrl,
        },
      ],
    },
  ]

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `🆘 Lead necesita asistencia manual: ${lead.nombre || lead.email}`,
        blocks,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error('Slack alertas-vambe failed', res.status, text.slice(0, 200))
      return { ok: false, error: `${res.status}: ${text.slice(0, 100)}` }
    }
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('Slack alertas-vambe error', msg)
    return { ok: false, error: msg }
  }
}
