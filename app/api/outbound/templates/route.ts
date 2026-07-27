import { NextResponse } from 'next/server'
import { listTemplates } from '@/lib/vambe'

export const dynamic = 'force-dynamic'

// Vambe a veces devuelve el body dentro de components: [{ type: 'BODY', text }]
function extractBody(components: unknown): string {
  if (!Array.isArray(components)) return ''
  for (const c of components as Array<Record<string, unknown>>) {
    const type = String((c?.type as string) || '').toUpperCase()
    if (type === 'BODY' || type === 'TEXT') {
      const t = (c?.text as string) || (c?.content as string) || (c?.body as string)
      if (typeof t === 'string') return t
    }
  }
  return ''
}

// GET /api/outbound/templates — lista de plantillas Vambe aprobadas, para
// reusar desde la tabla de Leads (envío masivo con casillas).
export async function GET() {
  try {
    const res = await listTemplates({ get_all: true })
    const all = ((res as { templates?: unknown[] }).templates || []) as Array<Record<string, unknown>>
    const approved = all.filter((t) => {
      const s = String((t?.status as string) || '').toLowerCase()
      return !s || s.includes('approv')
    })
    const templates = approved
      .map((t) => ({
        id: String(t.id || ''),
        name: String(t.name || ''),
        preview: String(
          (t.body as string) || (t.content as string) || (t.text as string) || extractBody(t.components) || '',
        ),
        category: String((t.category as string) || ''),
      }))
      .filter((t) => t.id && t.name)
    return NextResponse.json({ templates })
  } catch (e) {
    return NextResponse.json({ templates: [], error: e instanceof Error ? e.message : 'error' })
  }
}
