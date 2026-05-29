import { NextRequest, NextResponse } from 'next/server'
import { getMessages, parseFormMessage } from '@/lib/vambe'

export const dynamic = 'force-dynamic'

/**
 * GET /api/vambe/debug-contact?contact_id=AICONTACTID&secret=...
 *
 * Debug helper: trae los mensajes de un contacto de Vambe e intenta parsear
 * cada uno como formulario. Devuelve TODO en crudo para diagnosticar por qué
 * un lead no tiene vacante / presupuesto / etc.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!process.env.VAMBE_WEBHOOK_SECRET || secret !== process.env.VAMBE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const contactId = url.searchParams.get('contact_id')
  if (!contactId) {
    return NextResponse.json({ error: 'contact_id requerido' }, { status: 400 })
  }

  try {
    const messages = await getMessages(contactId, 100)
    const analyzed = messages.map((m, i) => ({
      idx: i,
      direction: m.direction,
      created_at: m.created_at,
      message_preview: (m.message || '').slice(0, 200),
      has_message: typeof m.message === 'string' && m.message.length > 0,
      colon_count: ((m.message || '').match(/:/g) || []).length,
      parsed_as_form: parseFormMessage(m.message || ''),
      raw: m,
    }))
    const anyParsed = analyzed.find(a => a.parsed_as_form)
    return NextResponse.json({
      contact_id: contactId,
      total_messages: messages.length,
      any_form_parsed: !!anyParsed,
      first_parsed: anyParsed?.parsed_as_form || null,
      messages: analyzed,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
