import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { isConnected } from '@/lib/googleCalendar'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createServiceClient()
  const result = await isConnected(supabase)
  return NextResponse.json({
    ...result,
    has_credentials: !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET),
  })
}
