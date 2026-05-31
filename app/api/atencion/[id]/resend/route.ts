import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { alertAtencionHumanaVambe } from '@/lib/slackAlertVambe'

export const dynamic = 'force-dynamic'

/**
 * GET /api/atencion/[id]/resend?secret=<DAPTA_POST_CALL_SECRET>
 *
 * Re-envía la alerta a #alertas-vambe para un ticket existente. Útil cuando
 * el alert original no se mandó (env var no aplicada, timing race, etc).
 *
 * Idempotente: NO crea ticket nuevo. Solo dispara el send a Slack.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const expected = process.env.CRON_SECRET || process.env.DAPTA_POST_CALL_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const { data: ticket, error } = await supabase
    .from('vambe_atencion_tickets')
    .select(`id, lead_id, last_message, status, leads:lead_id (*)`)
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!ticket) return NextResponse.json({ error: 'ticket no encontrado' }, { status: 404 })

  const t = ticket as { id: string; lead_id: string; last_message: string | null; leads: Lead | null }
  if (!t.leads) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })

  const result = await alertAtencionHumanaVambe({
    ticketId: t.id,
    lead: {
      id: t.leads.id, nombre: t.leads.nombre, email: t.leads.email,
      telefono: t.leads.telefono, empresa: t.leads.empresa,
      vacante: t.leads.vacante, presupuesto: t.leads.presupuesto,
    },
    lastMessage: t.last_message,
  })

  return NextResponse.json({
    ok: result.ok,
    error: result.error || null,
    has_webhook_url: !!(process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL || process.env.SLACK_ALERT_WEBHOOK_URL),
    webhook_var_used: process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL ? 'SLACK_ALERTAS_VAMBE_WEBHOOK_URL' : 'SLACK_ALERT_WEBHOOK_URL (fallback)',
  })
}
