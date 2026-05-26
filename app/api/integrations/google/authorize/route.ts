import { NextResponse } from 'next/server'
import { getAuthUrl } from '@/lib/googleCalendar'

export const dynamic = 'force-dynamic'

/** GET /api/integrations/google/authorize — redirige al consent screen de Google. */
export async function GET() {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return NextResponse.json({ error: 'Falta GOOGLE_OAUTH_CLIENT_ID en las env vars de Railway' }, { status: 500 })
  }
  return NextResponse.redirect(getAuthUrl())
}
