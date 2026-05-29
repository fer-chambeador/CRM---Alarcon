import { NextRequest, NextResponse } from 'next/server'
import { listTemplates } from '@/lib/vambe'

export const dynamic = 'force-dynamic'

/**
 * GET /api/templates
 *
 * Proxy a Vambe → lista los templates aprobados.
 * Query params soportados: status, category, language, channel_type, name, get_all.
 *
 * Por defecto pide `get_all=true` para traer todos y dejar el filtro client-side.
 */
export async function GET(req: NextRequest) {
  if (!process.env.VAMBE_API_KEY) {
    return NextResponse.json({ error: 'VAMBE_API_KEY no configurada' }, { status: 500 })
  }
  const url = new URL(req.url)
  try {
    const { templates } = await listTemplates({
      get_all: url.searchParams.get('get_all') !== 'false',
      status: url.searchParams.get('status') || undefined,
      category: url.searchParams.get('category') || undefined,
      language: url.searchParams.get('language') || undefined,
      channel_type: (url.searchParams.get('channel_type') as 'whatsapp' | undefined) || undefined,
      name: url.searchParams.get('name') || undefined,
    })
    return NextResponse.json({ templates })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
