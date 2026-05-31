import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const hours = parseInt(url.searchParams.get('hours') || '24', 10)
  const typeFilter = url.searchParams.get('type')
  const contactId = url.searchParams.get('contact_id')
  const limit = parseInt(url.searchParams.get('limit') || '50', 10)

  const supabase = createServiceClient()
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()

  let q = supabase.from('vambe_webhook_log').select('id, event_type, ai_contact_id, received_at, payload').gte('received_at', since).order('received_at', { ascending: false }).limit(limit)
  if (typeFilter) q = q.eq('event_type', typeFilter)
  if (contactId) q = q.eq('ai_contact_id', contactId)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data || []) as Array<{ id: string; event_type: string; ai_contact_id: string | null; received_at: string; payload: Record<string, unknown> }>
  const byType: Record<string, number> = {}
  for (const r of rows) byType[r.event_type] = (byType[r.event_type] || 0) + 1

  return NextResponse.json({
    hours_window: hours,
    total: rows.length,
    by_type: byType,
    rows: rows.slice(0, 20).map(r => ({
      event_type: r.event_type,
      ai_contact_id: r.ai_contact_id,
      received_at: r.received_at,
      payload_keys: Object.keys(r.payload || {}),
      stage_new: ((r.payload as Record<string, unknown>)?.data as Record<string, unknown>)?.new_stage_id || ((r.payload as Record<string, unknown>)?.data as Record<string, unknown>)?.newStageId || null,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
