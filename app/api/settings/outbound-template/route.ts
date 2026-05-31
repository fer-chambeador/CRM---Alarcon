import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { getOutboundTemplate, setSetting } from '@/lib/systemSettings'
import { listTemplates } from '@/lib/vambe'

export const dynamic = 'force-dynamic'

/**
 * GET /api/settings/outbound-template
 * Devuelve el template seleccionado actualmente + la lista de templates de Vambe.
 */
export async function GET() {
  const supabase = createServiceClient()
  const current = await getOutboundTemplate(supabase)

  // Pull todos los templates de Vambe (APPROVED + WhatsApp)
  let templates: Array<{ id: string; name?: string; status?: string; language?: string; body?: string }> = []
  try {
    const { templates: t } = await listTemplates({ get_all: true })
    templates = t as typeof templates
  } catch (e) {
    return NextResponse.json({
      current,
      templates: [],
      error: e instanceof Error ? e.message : 'no se pudo listar templates de Vambe',
    })
  }
  return NextResponse.json({ current, templates })
}

/**
 * POST /api/settings/outbound-template
 * Body: { template_id, template_name }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as
    | { template_id?: string; template_name?: string } | null
  if (!body?.template_id) {
    return NextResponse.json({ error: 'template_id requerido' }, { status: 400 })
  }
  const supabase = createServiceClient()
  await setSetting(supabase, 'vambe_outbound_template', {
    template_id: body.template_id,
    template_name: body.template_name || '(sin nombre)',
  })
  return NextResponse.json({ ok: true, value: { template_id: body.template_id, template_name: body.template_name } })
}
