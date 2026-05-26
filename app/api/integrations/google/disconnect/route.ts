import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { disconnect } from '@/lib/googleCalendar'

export const dynamic = 'force-dynamic'

export async function POST() {
  const supabase = createServiceClient()
  await disconnect(supabase)
  return NextResponse.json({ ok: true })
}
