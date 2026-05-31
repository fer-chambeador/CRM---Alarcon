/**
 * Slack alerts para eventos críticos del CRM.
 *
 * Usa un webhook de Slack incoming (env: SLACK_ALERT_WEBHOOK_URL).
 * Si no está configurado, las funciones no-op (no rompen el flujo principal).
 *
 * Casos cubiertos:
 *  - Vambe stage → Atención Humana: el lead requiere atención manual.
 *  - Vambe stage → Confirmados: el lead confirmó asistencia a llamada.
 *  - Vambe stage → Ganados: venta cerrada.
 *  - Lead nuevo con presupuesto 10000_plus → high-value alert.
 *
 * Mantenemos la lógica de "qué se alerta" en el código que llama, no acá.
 * Esta lib solo formatea y envía.
 */

export type SlackAlertSeverity = 'info' | 'warn' | 'critical' | 'success'

const COLOR_BY_SEVERITY: Record<SlackAlertSeverity, string> = {
  info: '#3b82f6',
  warn: '#f59e0b',
  critical: '#ef4444',
  success: '#10b981',
}

export type SlackAlertField = {
  title: string
  value: string
  short?: boolean
}

export type SlackAlertParams = {
  severity?: SlackAlertSeverity
  title: string                  // ej "🆘 Atención humana requerida"
  text?: string                  // ej "El lead {name} llegó al stage X"
  fields?: SlackAlertField[]
  url?: string                   // ej deep link al CRM /leads/[id]
  url_label?: string
  webhookUrl?: string            // override del default (e.g. canal #llamadas-dapta)
}

/**
 * Manda una alerta a Slack vía Incoming Webhook.
 * Best-effort — si falla solo loguea, no rompe el caller.
 */
export async function sendSlackAlert(params: SlackAlertParams): Promise<{ ok: boolean; error?: string }> {
  const webhookUrl = params.webhookUrl || process.env.SLACK_ALERT_WEBHOOK_URL
  if (!webhookUrl) {
    console.warn('Slack webhook no configurado — skip alert:', params.title)
    return { ok: false, error: 'no-webhook' }
  }

  const severity = params.severity || 'info'
  const color = COLOR_BY_SEVERITY[severity]

  // Construir attachments (formato classic Slack — funciona en cualquier webhook)
  const attachment: Record<string, unknown> = {
    color,
    title: params.title,
    text: params.text,
    fields: (params.fields || []).map(f => ({ title: f.title, value: f.value, short: f.short ?? true })),
    footer: 'Chambas CRM',
    ts: Math.floor(Date.now() / 1000),
  }
  if (params.url) {
    attachment.title_link = params.url
    attachment.actions = [{
      type: 'button',
      text: params.url_label || 'Abrir en CRM',
      url: params.url,
    }]
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        attachments: [attachment],
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error('Slack alert failed', res.status, text.slice(0, 200))
      return { ok: false, error: `${res.status}: ${text.slice(0, 100)}` }
    }
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('Slack alert error', msg)
    return { ok: false, error: msg }
  }
}

/**
 * Helper: alerta de atención humana para un lead de Vambe.
 */
export async function alertAtencionHumana(params: {
  leadId: string
  nombre: string | null
  email: string | null
  telefono: string | null
  vacante: string | null
  empresa: string | null
  inboxUrl?: string | null
  crmBaseUrl?: string
}): Promise<void> {
  const baseUrl = params.crmBaseUrl || process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
  const fields: SlackAlertField[] = []
  if (params.nombre) fields.push({ title: 'Nombre', value: params.nombre })
  if (params.empresa) fields.push({ title: 'Empresa', value: params.empresa })
  if (params.email) fields.push({ title: 'Email', value: params.email })
  if (params.telefono) fields.push({ title: 'Teléfono', value: params.telefono })
  if (params.vacante) fields.push({ title: 'Vacante', value: params.vacante })
  if (params.inboxUrl) fields.push({ title: 'Inbox Vambe', value: params.inboxUrl, short: false })

  await sendSlackAlert({
    severity: 'warn',
    title: '🆘 Atención humana requerida en Vambe',
    text: `Un lead necesita intervención manual — la AI escaló la conversación.`,
    fields,
    url: `${baseUrl}/leads?email=${encodeURIComponent(params.email || '')}`,
    url_label: 'Ver lead en CRM',
  })
}

/**
 * Helper: alerta cuando un lead llega a "Ganados" (venta cerrada).
 */
export async function alertVentaCerrada(params: {
  leadId: string
  nombre: string | null
  email: string | null
  empresa: string | null
  monto: number
  crmBaseUrl?: string
}): Promise<void> {
  const baseUrl = params.crmBaseUrl || process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
  const fields: SlackAlertField[] = []
  if (params.nombre) fields.push({ title: 'Cliente', value: params.nombre })
  if (params.empresa) fields.push({ title: 'Empresa', value: params.empresa })
  if (params.email) fields.push({ title: 'Email', value: params.email })
  fields.push({ title: 'Monto', value: `$${params.monto.toLocaleString('es-MX')} MXN` })

  await sendSlackAlert({
    severity: 'success',
    title: '🎉 Venta cerrada desde Vambe',
    text: `Un lead pasó al stage "Ganados". ¡A facturar!`,
    fields,
    url: `${baseUrl}/leads?email=${encodeURIComponent(params.email || '')}`,
  })
}

/**
 * Helper: alerta high-value cuando un lead nuevo tiene presupuesto 10000+.
 */
export async function alertHighValueLead(params: {
  leadId: string
  nombre: string | null
  email: string | null
  empresa: string | null
  vacante: string | null
  presupuesto: string | null
  crmBaseUrl?: string
}): Promise<void> {
  const baseUrl = params.crmBaseUrl || process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
  const fields: SlackAlertField[] = []
  if (params.nombre) fields.push({ title: 'Nombre', value: params.nombre })
  if (params.empresa) fields.push({ title: 'Empresa', value: params.empresa })
  if (params.email) fields.push({ title: 'Email', value: params.email })
  if (params.vacante) fields.push({ title: 'Vacante', value: params.vacante })
  fields.push({ title: 'Presupuesto', value: params.presupuesto || '10,000+' })

  await sendSlackAlert({
    severity: 'critical',
    title: '💎 Lead high-value entró por Vambe',
    text: `Presupuesto >$10,000 — priorizá esta cuenta.`,
    fields,
    url: `${baseUrl}/leads?email=${encodeURIComponent(params.email || '')}`,
  })
}
