import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { ensureWatchChannel, appBaseUrl } from '@/lib/googleCalendar'
import { getSetting } from '@/lib/systemSettings'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * Administración del canal de push notifications de Google Calendar.
 *
 * GET  /api/gcal/watch?secret=...            → estado del canal actual
 * POST /api/gcal/watch?secret=...            → asegura/renueva el canal
 * POST /api/gcal/watch?secret=...&force=1    → fuerza re-registro (debug)
 *
 * Secret: CRON_SECRET o DAPTA_POST_CALL_SECRET (mismos del resto de crons).
 */
function authorized(req: NextRequest): boolean {
  const secret = new URL(req.url).searchParams.get('secret') || req.headers.get('x-cron-secret')
  const expected = process.env.CRON_SECRET || process.env.DAPTA_POST_CALL_SECRET
  return !!expected && secret === expected
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const supabase = createServiceClient()
  const channel = await getSetting(supabase, 'gcal_watch_channel')
  return NextResponse.json({
    ok: true,
    webhook_url: `${appBaseUrl()}/api/gcal/webhook`,
    channel: channel || null,
    expired: channel ? new Date(channel.expiration).getTime() < Date.now() : null,
  })
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const force = new URL(req.url).searchParams.get('force') === '1'
  const supabase = createServiceClient()
  const result = await ensureWatchChannel(supabase, force)
  const status = result.error && result.action === 'skipped' ? 500 : 200
  return NextResponse.json({ ok: !result.error, ...result }, { status })
}
