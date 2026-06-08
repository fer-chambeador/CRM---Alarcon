import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { getValidAccessToken } from '@/lib/googleCalendar'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Marca como transparent (no-busy) todos los Follow Up events existentes en
 * Google Calendar para que NO bloqueen agendamiento de Vambe/Cal.com/Calendly.
 *
 * Bug 8-jun-2026: caso Sandra Monjaras +5214281123167 — Vambe bot decía
 * "error el calendario en ese horario" porque los Follow Up imports a GCal
 * estaban como opaque y bloqueaban el día entero.
 *
 * Lee gcal_followup_event_id (legacy) y follow_ups.gcal_event_id (nuevo),
 * patches cada evento a transparency='transparent'. Best-effort.
 *
 * Protegido por ?secret=DAPTA_POST_CALL_SECRET.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || ''
  const expected = process.env.DAPTA_POST_CALL_SECRET || ''
  if (!expected || secret !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const auth = await getValidAccessToken(supabase)
  if (!auth) {
    return NextResponse.json({ ok: false, error: 'Google Calendar no conectado' }, { status: 500 })
  }

  // ── IDs de Follow Up events en GCal ──
  const eventIds = new Set<string>()
  const { data: leadsWithEvents } = await supabase
    .from('leads')
    .select('gcal_followup_event_id')
    .not('gcal_followup_event_id', 'is', null)
    .limit(5000)
  for (const r of (leadsWithEvents || []) as Array<{ gcal_followup_event_id: string }>) {
    if (r.gcal_followup_event_id) eventIds.add(r.gcal_followup_event_id)
  }
  const { data: followUpsWithEvents } = await supabase
    .from('follow_ups')
    .select('gcal_event_id')
    .not('gcal_event_id', 'is', null)
    .limit(5000)
  for (const r of (followUpsWithEvents || []) as Array<{ gcal_event_id: string }>) {
    if (r.gcal_event_id) eventIds.add(r.gcal_event_id)
  }

  const patched: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  const calId = encodeURIComponent(auth.calendarId)

  for (const eventId of Array.from(eventIds)) {
    try {
      const r = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(eventId)}`,
        {
          method: 'PATCH',
          headers: {
            'authorization': `Bearer ${auth.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            transparency: 'transparent',
            visibility: 'private',
          }),
        },
      )
      if (r.ok) {
        patched.push(eventId)
      } else {
        const txt = await r.text()
        skipped.push({ id: eventId, reason: `${r.status}: ${txt.slice(0, 120)}` })
      }
    } catch (e) {
      skipped.push({ id: eventId, reason: String(e).slice(0, 120) })
    }
  }

  return NextResponse.json({
    ok: true,
    totalEventIds: eventIds.size,
    patched: patched.length,
    skipped: skipped.length,
    skippedItems: skipped.slice(0, 20),
  })
}
