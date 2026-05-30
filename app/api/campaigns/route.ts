import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/campaigns
 *
 * Lista las campañas (envíos de template) con métricas agregadas.
 * Soporta ?limit=N (default 50).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || '50')))

  const supabase = createServiceClient()

  const { data: campaigns, error } = await supabase
    .from('vambe_campaigns')
    .select('id, template_id, template_name, template_body, segment, override_vars, total_targeted, total_sent, total_failed, source, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    // Si la tabla no existe (migration no corrida) → devolver vacío en lugar de 500
    if (error.message?.includes('relation') || error.code === '42P01') {
      return NextResponse.json({ campaigns: [], note: 'Migration de vambe_campaigns pendiente. Corré sql/migrations/2026-05-30-vambe-campaigns.sql en Supabase.' })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  const rows = campaigns || []

  if (rows.length === 0) {
    return NextResponse.json({ campaigns: [] })
  }

  // Para cada campaign, contar outcomes (sin traer cada recipient)
  const ids = rows.map(c => c.id)
  const { data: outcomes } = await supabase
    .from('vambe_campaign_recipients')
    .select('campaign_id, sent_at, responded_at, scheduled_call_at, paid_at, send_error')
    .in('campaign_id', ids)

  const byCampaign: Record<string, {
    sent: number; failed: number;
    responded: number; scheduled: number; paid: number;
  }> = {}
  for (const id of ids) byCampaign[id] = { sent: 0, failed: 0, responded: 0, scheduled: 0, paid: 0 }
  for (const r of outcomes || []) {
    const m = byCampaign[r.campaign_id as string]
    if (!m) continue
    if (r.sent_at) m.sent++
    if (r.send_error) m.failed++
    if (r.responded_at) m.responded++
    if (r.scheduled_call_at) m.scheduled++
    if (r.paid_at) m.paid++
  }

  const enriched = rows.map(c => {
    const m = byCampaign[c.id]
    const respondedRate = m.sent > 0 ? m.responded / m.sent : 0
    const scheduledRate = m.sent > 0 ? m.scheduled / m.sent : 0
    const paidRate = m.sent > 0 ? m.paid / m.sent : 0
    return {
      ...c,
      metrics: {
        ...m,
        responded_rate: respondedRate,
        scheduled_rate: scheduledRate,
        paid_rate: paidRate,
      },
    }
  })

  return NextResponse.json({ campaigns: enriched })
}
