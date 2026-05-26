import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { importEventsToLeads } from '@/lib/googleCalendar'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** POST /api/integrations/google/import — sync Calendar → CRM. */
export async function POST() {
  const supabase = createServiceClient()
  try {
    const result = await importEventsToLeads(supabase)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
