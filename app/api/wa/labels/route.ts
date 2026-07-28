import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * POST /api/wa/labels  { phone: string, labels: string[] }
 *
 * El WA Bridge reporta las etiquetas de WhatsApp Business de un chat 1:1.
 * Matcheamos el lead por los ultimos 10 digitos del telefono y guardamos
 * las etiquetas en leads.etiqueta_wa. Idempotente: si la etiqueta no cambio
 * NO escribe (evita spam en el timeline).
 *
 * Auth: header x-bridge-secret == WA_BRIDGE_SECRET (mismo valor que el bridge).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.WA_BRIDGE_SECRET || ''
  if (!secret || req.headers.get('x-bridge-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: { phone?: string; labels?: string[] } = {}
  try { body = await req.json() } catch { /* body vacio */ }

  const digits = String(body.phone || '').replace(/[^0-9]/g, '').slice(-10)
  if (digits.length !== 10) return NextResponse.json({ ok: false, error: 'phone invalido' })

  const labels = Array.isArray(body.labels) ? body.labels.filter(Boolean).map(String) : []
  const etiqueta = labels.join(', ') || null

  const supabase = createServiceClient()
  const { data: leads } = await supabase
    .from('leads')
    .select('id, etiqueta_wa')
    .ilike('telefono', `%${digits}`)
    .limit(1)
  const lead = leads && leads[0]
  if (!lead) return NextResponse.json({ ok: true, matched: false })

  if (((lead.etiqueta_wa as string | null) || null) === etiqueta) {
    return NextResponse.json({ ok: true, matched: true, changed: false })
  }

  await supabase.from('leads').update({ etiqueta_wa: etiqueta }).eq('id', lead.id)
  await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'wa_label',
    descripcion: `🏷️ Etiqueta WhatsApp: ${etiqueta || '(sin etiqueta)'}`,
    metadata: { source: 'wa_bridge', labels },
  })
  return NextResponse.json({ ok: true, matched: true, changed: true, etiqueta })
}
