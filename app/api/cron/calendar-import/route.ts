import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { importEventsToLeads } from '@/lib/googleCalendar'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET o POST /api/cron/calendar-import
 *
 * Endpoint protegido para que Railway Cron Job (u otro scheduler externo)
 * dispare el import del Calendar al CRM cada N minutos.
 *
 * Auth: header `x-cron-secret` o query param `?secret=...` que matchee CRON_SECRET.
 *
 * Setup en Railway:
 *   1. En el mismo proyecto del CRM, agregá un nuevo servicio tipo "Cron Job".
 *   2. Schedule: cada 10 min → cron expression "STAR/10 STAR STAR STAR STAR" (cambia STAR por *)
 *   3. Command:
 *      curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" \
 *        https://crm-alarcon-production.up.railway.app/api/cron/calendar-import
 *   4. Env var en el cron service: CRON_SECRET (mismo valor que en el web service)
 *   5. Env var en el WEB service del CRM: CRON_SECRET (genéralo con `openssl rand -base64 32`)
 */
async function handle(req: NextRequest) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json({
      error: 'CRON_SECRET no configurado en el server',
    }, { status: 500 })
  }
  const provided = req.headers.get('x-cron-secret')
    || new URL(req.url).searchParams.get('secret')
  if (provided !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  try {
    const result = await importEventsToLeads(supabase)
    return NextResponse.json({
      ok: true,
      ran_at: new Date().toISOString(),
      ...result,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

export const POST = handle
export const GET = handle
