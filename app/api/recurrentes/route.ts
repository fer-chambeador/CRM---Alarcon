import { NextResponse } from 'next/server'
import { fetchRecurrentes } from '@/lib/recurrentes'

export const dynamic = 'force-dynamic'
export const revalidate = 60  // cache 60s para no spamear a Google
export const runtime = 'nodejs'

export async function GET() {
  try {
    const data = await fetchRecurrentes()
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown' },
      { status: 500 }
    )
  }
}
