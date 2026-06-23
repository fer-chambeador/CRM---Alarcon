/**
 * GET /api/debug/alertas-vambe-status?secret=<VAMBE_WEBHOOK_SECRET>
 *
 * Diagnóstico de #alertas-vambe — por qué no llegan mensajes a Slack.
 * Reporta:
 *  - Webhooks de Vambe recibidos en las últimas 24h (por tipo)
 *  - Alertas que el CRM intentó disparar (lead_actividad tipo nuevo_mensaje_alert)
 *  - Si webhook URL Slack está configurada (sin revelar valor)
 *  - Opcional: ?ping=1 → manda un mensaje de prueba al canal
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { getSetting } from '@/lib/systemSettings'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!process.env.VAMBE_WEBHOOK_SECRET || secret !== process.env.VAMBE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const ping = url.searchParams.get('ping') === '1'

  const supabase = createServiceClient()
  const now = Date.now()
  const dayAgo = new Date(now - 24 * 3600_000).toISOString()
  const weekAgo = new Date(now - 7 * 24 * 3600_000).toISOString()

  // 1. Webhook log — eventos por tipo en las últimas 24h y 7d
  let webhookByType24h: Record<string, number> = {}
  let webhookByType7d: Record<string, number> = {}
  let totalLogged24h = 0
  let totalLogged7d = 0
  let lastWebhookAt: string | null = null
  try {
    const { data: logs24 } = await supabase
      .from('vambe_webhook_log')
      .select('event_type, received_at')
      .gte('received_at', dayAgo)
    if (logs24) {
      totalLogged24h = logs24.length
      for (const row of logs24 as Array<{ event_type: string; received_at: string }>) {
        webhookByType24h[row.event_type] = (webhookByType24h[row.event_type] || 0) + 1
        if (!lastWebhookAt || row.received_at > lastWebhookAt) lastWebhookAt = row.received_at
      }
    }
    const { data: logs7 } = await supabase
      .from('vambe_webhook_log')
      .select('event_type')
      .gte('received_at', weekAgo)
    if (logs7) {
      totalLogged7d = logs7.length
      for (const row of logs7 as Array<{ event_type: string }>) {
        webhookByType7d[row.event_type] = (webhookByType7d[row.event_type] || 0) + 1
      }
    }
  } catch (e) {
    webhookByType24h = { error: (e as Error).message } as unknown as Record<string, number>
  }

  // 2. Alertas Slack disparadas — lead_actividad
  const alertTypes = [
    'nuevo_mensaje_alert',
    'reminder_response_alert',
    'lead_viejo_reactivado',
    'atencion_humana_alert',
  ]
  const alertsByType24h: Record<string, number> = {}
  let lastAlertAt: string | null = null
  for (const tipo of alertTypes) {
    const { data } = await supabase
      .from('lead_actividad')
      .select('created_at')
      .eq('tipo', tipo)
      .gte('created_at', dayAgo)
      .order('created_at', { ascending: false })
    alertsByType24h[tipo] = data?.length || 0
    if (data && data.length > 0) {
      const ts = (data[0] as { created_at: string }).created_at
      if (!lastAlertAt || ts > lastAlertAt) lastAlertAt = ts
    }
  }

  // 3. Webhook URL en env / DB?
  const envSet = !!process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL
  const dbValue = await getSetting(supabase, 'slack_alertas_vambe_webhook')
  const dbSet = !!dbValue
  const effectiveUrl = process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL || dbValue || process.env.SLACK_ALERT_WEBHOOK_URL || null
  const webhookSource = process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL ? 'env'
    : dbValue ? 'db'
    : process.env.SLACK_ALERT_WEBHOOK_URL ? 'env-fallback'
    : 'none'

  // 4. Stages que disparan alerta de nuevo mensaje — cuántos leads viven ahí
  const ALERT_STAGE_IDS = [
    'dd41a38e-3b22-42f3-a6d3-b130b9ca449f', // Asistencia Humana
    '2fc44415-960f-4dbd-b65b-1500636fc41a', // Confirmados
    'cd0ab574-c844-4346-bea3-4ddd084fcb92', // Llamadas
    '5847352c-f983-4e8b-b635-b19797d031a8', // Contactados WA
    'c86a7911-ef9d-4f6d-8c90-3e9a9a4d6b50', // Ganados
  ]
  const leadsInAlertStages: Record<string, number> = {}
  for (const stageId of ALERT_STAGE_IDS) {
    const { count } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('vambe_stage_id', stageId)
    leadsInAlertStages[stageId] = count || 0
  }

  // 5. PING opcional
  let pingResult: { ok: boolean; status?: number; error?: string } | null = null
  if (ping && effectiveUrl) {
    try {
      const res = await fetch(effectiveUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: '🧪 Test ping desde CRM — verificando #alertas-vambe',
        }),
      })
      pingResult = { ok: res.ok, status: res.status }
      if (!res.ok) {
        pingResult.error = (await res.text()).slice(0, 200)
      }
    } catch (e) {
      pingResult = { ok: false, error: (e as Error).message }
    }
  }

  return NextResponse.json({
    webhook_url: {
      env_set: envSet,
      db_set: dbSet,
      source: webhookSource,
      preview: effectiveUrl ? effectiveUrl.slice(0, 35) + '…' : null,
    },
    vambe_webhooks_received: {
      total_24h: totalLogged24h,
      total_7d: totalLogged7d,
      last_event_at: lastWebhookAt,
      by_type_24h: webhookByType24h,
      by_type_7d: webhookByType7d,
    },
    crm_alerts_dispatched_24h: {
      ...alertsByType24h,
      total: Object.values(alertsByType24h).reduce((a, b) => a + b, 0),
      last_alert_at: lastAlertAt,
    },
    leads_in_alert_stages: leadsInAlertStages,
    ping_result: pingResult,
    diagnosis: diagnose({
      hasWebhookUrl: !!effectiveUrl,
      vambeWebhooks24h: totalLogged24h,
      alertsDispatched24h: Object.values(alertsByType24h).reduce((a, b) => a + b, 0),
      pingResult,
    }),
  })
}

function diagnose(s: {
  hasWebhookUrl: boolean
  vambeWebhooks24h: number
  alertsDispatched24h: number
  pingResult: { ok: boolean } | null
}): string {
  if (!s.hasWebhookUrl) return '❌ No hay webhook URL configurada (ni env ni DB) — el CRM no puede mandar a Slack.'
  if (s.vambeWebhooks24h === 0) return '❌ Vambe NO está pegando al webhook del CRM. Verifica POST /api/webhooks en Vambe o /settings → Desarrolladores.'
  if (s.pingResult && !s.pingResult.ok) return '❌ El webhook URL responde con error — probablemente revocado o canal borrado.'
  if (s.alertsDispatched24h === 0 && s.vambeWebhooks24h > 0) return '⚠️ Llegan webhooks pero NO se dispara ninguna alerta — los stage_id de los leads no matchean los 5 stages clave, o los mensajes no son inbound.'
  if (s.alertsDispatched24h > 0) return '✅ Las alertas SÍ se están disparando desde el CRM. Si Fer no las ve en Slack, el problema es el webhook URL (canal borrado, app desconectada) — corré con ?ping=1 para probar.'
  return '?'
}
