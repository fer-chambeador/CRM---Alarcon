/**
 * Slack alerts específicos para llamadas Dapta.
 *
 * Solo disparamos en los dos outcomes críticos que el usuario pidió:
 *   1. Lead pidió link de pago / transferencia  → ¡acción comercial urgente!
 *   2. Lead pidió presentación comercial         → mandar PDF + follow-up
 *
 * Reutiliza `sendSlackAlert` (lib/slackAlert.ts).
 */

import { sendSlackAlert, type SlackAlertField } from '@/lib/slackAlert'
import type { DaptaCustomAnalysis } from '@/lib/dapta'

type LeadSnapshot = {
  id: string
  nombre: string | null
  email: string | null
  empresa: string | null
  telefono: string | null
  presupuesto: string | null
  vacante: string | null
}

type CallSnapshot = {
  id: string
  dapta_call_id?: string | null
  duration_seconds: number | null
  summary: string | null
  recording_url: string | null
  custom_analysis: DaptaCustomAnalysis | null
}

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
}

function buildLeadFields(lead: LeadSnapshot): SlackAlertField[] {
  const fields: SlackAlertField[] = []
  if (lead.nombre) fields.push({ title: 'Lead', value: lead.nombre })
  if (lead.empresa) fields.push({ title: 'Empresa', value: lead.empresa })
  if (lead.email) fields.push({ title: 'Email', value: lead.email })
  if (lead.telefono) fields.push({ title: 'Teléfono', value: lead.telefono })
  if (lead.vacante) fields.push({ title: 'Vacante', value: lead.vacante })
  if (lead.presupuesto) fields.push({ title: 'Presupuesto', value: lead.presupuesto })
  return fields
}

function appendCallFields(fields: SlackAlertField[], call: CallSnapshot): SlackAlertField[] {
  const c = call.custom_analysis || {}
  if (call.duration_seconds) fields.push({ title: 'Duración', value: formatDuration(call.duration_seconds) })
  if (c.interes_real) fields.push({ title: 'Interés', value: c.interes_real })
  if (c.proximo_paso) fields.push({ title: 'Próximo paso', value: c.proximo_paso, short: false })
  if (c.presupuesto_paquete && c.presupuesto_paquete !== 'no_definido') {
    fields.push({ title: 'Paquete', value: c.presupuesto_paquete })
  }
  if (c.zona_ubicacion) fields.push({ title: 'Zona', value: c.zona_ubicacion })
  if (call.summary) fields.push({ title: 'Resumen', value: call.summary.slice(0, 500), short: false })
  return fields
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Webhook específico para llamadas. Si `SLACK_LLAMADAS_WEBHOOK_URL` está
 * configurado, las alertas Dapta van al canal #llamadas-dapta; sino, caen
 * al webhook por default.
 */
function llamadasWebhook(): string | undefined {
  return process.env.SLACK_LLAMADAS_WEBHOOK_URL || process.env.SLACK_ALERT_WEBHOOK_URL
}

/**
 * 💰 Lead aceptó comprar — pidió link de pago o transferencia.
 * Acción urgente: mandar liga por WhatsApp YA.
 */
export async function alertLlamadaPidioLinkPago(params: { lead: LeadSnapshot; call: CallSnapshot }): Promise<void> {
  const fields = buildLeadFields(params.lead)
  appendCallFields(fields, params.call)

  await sendSlackAlert({
    severity: 'success',
    title: '💰 Lead pidió liga de pago — cerrar venta YA',
    text: 'Daniela cerró la llamada con el cliente aceptando comprar. Manda la liga de pago / datos de transferencia por WhatsApp.',
    fields,
    url: `${baseUrl()}/llamadas/${params.call.id}`,
    url_label: 'Ver llamada completa',
    webhookUrl: llamadasWebhook(),
  })
}

/**
 * 📋 Lead pidió presentación comercial.
 * Puede ser paquete grande o "déjame pensarlo" — manda el PDF + follow-up.
 */
export async function alertLlamadaPidioPresentacion(params: { lead: LeadSnapshot; call: CallSnapshot }): Promise<void> {
  const fields = buildLeadFields(params.lead)
  appendCallFields(fields, params.call)

  await sendSlackAlert({
    severity: 'info',
    title: '📋 Lead pidió la presentación comercial',
    text: 'El cliente quiere ver el detalle (paquete grande o lo está pensando). Manda la presentación comercial y agendá follow-up.',
    fields,
    url: `${baseUrl()}/llamadas/${params.call.id}`,
    url_label: 'Ver llamada completa',
    webhookUrl: llamadasWebhook(),
  })
}
