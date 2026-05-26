import { NextRequest, NextResponse } from 'next/server'
import { exchangeCode, saveTokens } from '@/lib/googleCalendar'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/** GET /api/integrations/google/callback?code=... — recibe code de Google, intercambia por tokens. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  const redirectBase = url.origin

  if (error) {
    return NextResponse.redirect(`${redirectBase}/settings?google=error&msg=${encodeURIComponent(error)}`)
  }
  if (!code) {
    return NextResponse.redirect(`${redirectBase}/settings?google=error&msg=missing_code`)
  }

  try {
    const tokens = await exchangeCode(code)
    const supabase = createServiceClient()
    await saveTokens(supabase, tokens)
    return NextResponse.redirect(`${redirectBase}/settings?google=connected`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return NextResponse.redirect(`${redirectBase}/settings?google=error&msg=${encodeURIComponent(msg)}`)
  }
}
