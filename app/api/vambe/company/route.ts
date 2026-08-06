import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * POST /api/vambe/company  { phone: string, empresa: string }
 *
 * El asistente Outbound de Vambe reporta el nombre de la empresa que el lead
 * dijo en el chat, para guardarlo en leads.empresa. Los leads del anuncio
 * llegan sin empresa (su correo es sintetico), asi que aqui la capturamos.
 * Match por los ultimos 10 digitos del telefono. NO pisa una empresa ya puesta
 * (esa suele venir del formulario); solo llena cuando esta vacia.
 *
 * Auth: header x-bridge-secret == WA_BRIDGE_SECRET.
 */
const clean = (s: unknown) => String(s ?? '').trim()

export async function POST(req: NextRequest) {
  const secret = process.env.WA_BRIDGE_SECRET || ''
  if (!secret || req.headers.get('x-bridge-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: { phone?: string; empresa?: string } = {}
  try { body = await req.json() } catch { /* body vacio */ }

  const digits = String(body.phone || '').replace(/[^0-9]/g, '').slice(-10)
  const empresa = clean(body.empresa)
  if (digits.length !== 10) return NextResponse.json({ ok: false, error: 'phone invalido' })
  if (!empresa || empresa.length < 2) return NextResponse.json({ ok: false, error: 'empresa vacia' })

  const supabase = createServiceClient()
  const { data: leads } = await supabase
    .from('leads')
    .select('id, empresa')
    .ilike('telefono', '%' + digits)
    .limit(1)
  const lead = leads && leads[0]
  if (!lead) return NextResponse.json({ ok: true, matched: false })

  const current = clean(lead.empresa)
  if (current) {
    return NextResponse.json({ ok: true, matched: true, changed: false, kept: current })
  }

  await supabase.from('leads').update({ empresa }).eq('id', lead.id)
  await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'empresa_capturada',
    descripcion: 'Empresa capturada del chat: ' + empresa,
    metadata: { source: 'vambe_chat' },
  })

  return NextResponse.json({ ok: true, matched: true, changed: true, empresa })
}
