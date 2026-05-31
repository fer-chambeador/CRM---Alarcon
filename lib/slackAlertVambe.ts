/**
 * Slack alerts para Vambe — canal #alertas-vambe.
 *
 * Webhook resolution (en orden de prioridad):
 *   1. process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL  (Railway env)
 *   2. system_settings.slack_alertas_vambe_webhook  (DB — fallback robusto)
 *   3. process.env.SLACK_ALERT_WEBHOOK_URL          (canal default si existe)
 *
 * Briefing (campo "¿Qué necesita?"):
 *   - Si hay mensajes recientes del cliente en lead_actividad, los pasamos a
 *     Claude Haiku para generar un briefing inteligente (1 oración, qué pide).
 *   - Si Haiku falla o no hay mensajes, fallback al texto del último mensaje
 *     o, en último caso, vacante + empresa + presupuesto.
 */

import type { Lead } from '@/lib/supabase'
import { createServiceClient } from '@/lib/supabase'
import { getSetting } from '@/lib/systemSettings'

type Supabase = ReturnType<typeof createServiceClient>

function crmBaseUrl(): string {
  return process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
}

async function alertasVambeWebhook(supabase: Supabase): Promise<string | undefined> {
  // 1. Env var (Railway recomendado, pero tuvo problemas de propagación)
  if (process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL) {
    return process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL
  }
  // 2. DB system_settings (fallback robusto sin depender de Railway env)
  const dbUrl = await getSetting(supabase, 'slack_alertas_vambe_webhook')
  if (dbUrl) return dbUrl
  // 3. Default fallback — canal genérico (último resort)
  return process.env.SLACK_ALERT_WEBHOOK_URL
}

/**
 * Genera briefing inteligente con Claude Haiku usando los últimos mensajes
 * del lead. Devuelve UNA frase tipo:
 *   "Pide hablar con humano para confirmar precio del paquete grande."
 *   "Tiene dudas sobre tiempos de entrega y precio."
 *
 * Si Haiku falla o no hay mensajes, devuelve null y el caller usa fallback.
 */
async function generateBriefingWithLLM(
  supabase: Supabase,
  leadId: string,
  lead: Pick<Lead, 'nombre' | 'empresa' | 'vacante'>,
): Promise<string | null> {
  // Pull los últimos mensajes inbound + outbound del lead
  const { data: msgs } = await supabase
    .from('lead_actividad')
    .select('descripcion, metadata, created_at')
    .eq('lead_id', leadId)
    .eq('tipo', 'vambe_message')
    .order('created_at', { ascending: false })
    .limit(10)
  if (!msgs || msgs.length === 0) return null

  // Reconstruir la conversación reciente (en orden cronológico ascendente)
  type Msg = { descripcion?: string; metadata?: { text?: string; last_text?: string; messages?: Array<{ text?: string }> }; created_at: string }
  const conversation: Array<{ role: 'cliente' | 'vambe'; text: string }> = []
  for (const m of (msgs as Msg[]).reverse()) {
    const isInbound = (m.descripcion || '').startsWith('📥')
    const role: 'cliente' | 'vambe' = isInbound ? 'cliente' : 'vambe'
    const meta = m.metadata || {}
    // Si hay messages array (consolidado), tomar todos los textos
    if (Array.isArray(meta.messages) && meta.messages.length > 0) {
      for (const mm of meta.messages) {
        if (mm.text) conversation.push({ role, text: mm.text })
      }
    } else if (meta.text || meta.last_text) {
      conversation.push({ role, text: (meta.text || meta.last_text || '').slice(0, 500) })
    }
  }
  // Quedarnos con los últimos 12 turnos (la conversación reciente)
  const recent = conversation.slice(-12)
  if (recent.length === 0) return null

  const transcript = recent.map(t => `${t.role}: ${t.text}`).join('\n')

  // Llamar a Claude Haiku — rápido y barato para summarization
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_KEY) return null

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: `Eres un asistente comercial de Chambas Ay (plataforma de reclutamiento por WhatsApp). Un lead acaba de pasar al stage "Asistencia Humana" en Vambe, lo que significa que la AI no pudo seguir atendiéndolo y necesita intervención de Fer. Tu tarea: en UNA sola oración (max 25 palabras), describí EXACTAMENTE QUÉ NECESITA EL LEAD basándote en la conversación. Sé concreto y accionable. NO uses formato, solo la oración. Ejemplos buenos:
- "Pide hablar con un humano para confirmar el precio del paquete grande."
- "Tiene dudas sobre cómo se cobra el servicio y quiere agendar llamada."
- "Lleva 3 mensajes pidiendo callback urgente, no responde a horarios sugeridos."
- "Pregunta si pueden facturar y necesita un asesor que confirme detalles fiscales."`,
        messages: [{
          role: 'user',
          content: `Lead: ${lead.nombre || '(sin nombre)'} de ${lead.empresa || 'empresa desconocida'}, busca cubrir vacante de ${lead.vacante || 'no especificada'}.

Conversación reciente con la AI (Vambe):
${transcript}

¿Qué necesita?`,
        }],
      }),
    })
    if (!res.ok) {
      console.error('Anthropic briefing failed', res.status, (await res.text()).slice(0, 200))
      return null
    }
    const data = await res.json() as { content?: Array<{ type: string; text: string }> }
    const text = data.content?.find(c => c.type === 'text')?.text?.trim()
    if (!text) return null
    // Truncar por las dudas a 200 chars
    return text.slice(0, 200)
  } catch (e) {
    console.error('Anthropic briefing exception', e)
    return null
  }
}

/**
 * Fallback heurístico cuando Haiku no aplicó.
 */
function summarizeNeedFallback(lastMessage: string | null, lead: Pick<Lead, 'vacante' | 'empresa' | 'presupuesto'>): string {
  const msg = (lastMessage || '').trim()
  if (msg) {
    if (msg.length <= 180) return msg
    const firstSentence = msg.split(/[.!?]\s/)[0]
    if (firstSentence.length <= 200) return firstSentence + (firstSentence !== msg ? '…' : '')
    return msg.slice(0, 180) + '…'
  }
  const parts: string[] = []
  if (lead.vacante) parts.push(`Necesita reclutar: ${lead.vacante}`)
  if (lead.empresa) parts.push(`Empresa: ${lead.empresa}`)
  if (lead.presupuesto) parts.push(`Presupuesto: ${lead.presupuesto}`)
  return parts.length ? parts.join(' · ') : '(no hay contexto del mensaje, revisa el chat)'
}

/**
 * Manda alerta a #alertas-vambe usando Block Kit con botones URL.
 */
export async function alertAtencionHumanaVambe(params: {
  ticketId: string
  lead: Pick<Lead, 'id' | 'nombre' | 'email' | 'telefono' | 'empresa' | 'vacante' | 'presupuesto'>
  lastMessage: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = createServiceClient()
  const webhookUrl = await alertasVambeWebhook(supabase)
  if (!webhookUrl) {
    console.warn('Webhook #alertas-vambe no configurado (ni env ni DB)')
    return { ok: false, error: 'no-webhook' }
  }

  const { ticketId, lead, lastMessage } = params

  // BRIEFING INTELIGENTE con Haiku — si falla, fallback al texto literal.
  let resumen = await generateBriefingWithLLM(supabase, lead.id, lead)
  if (!resumen) resumen = summarizeNeedFallback(lastMessage, lead)

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

// Re-export deprecated para compatibilidad si lo importan en otros archivos
export function summarizeNeed(lastMessage: string | null, lead: Pick<Lead, 'vacante' | 'empresa' | 'presupuesto'>): string {
  return summarizeNeedFallback(lastMessage, lead)
}
