import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * POST /api/wa/labels  { phone: string, labels: string[] }
 *
 * El WA Bridge reporta las etiquetas de WhatsApp Business de un chat 1:1.
 * Matcheamos el lead por los ultimos 10 digitos del telefono y guardamos
 * las etiquetas en leads.etiqueta_wa. Idempotente: si nada cambio NO escribe.
 *
 * Ademas, ciertas etiquetas marcan CONVERSION: si el chat trae una etiqueta
 * de CONVERT_LABELS (ej. "CLIENTE PAGANDO"), el lead pasa a status 'convertido'
 * y se estampa status_changed_at (para que cuente en pipeline cerrado).
 *
 * Auth: header x-bridge-secret == WA_BRIDGE_SECRET (mismo valor que el bridge).
 */

// Etiquetas de WhatsApp Business que significan que el lead YA es cliente.
const CONVERT_LABELS = ['cliente pagando']
const norm = (s: string) => s.trim().toLowerCase()

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
  const isConverted = labels.some((l) => CONVERT_LABELS.includes(norm(l)))

  const supabase = createServiceClient()
  const { data: leads } = await supabase
    .from('leads')
    .select('id, etiqueta_wa, status')
    .ilike('telefono', `%${digits}`)
    .limit(1)
  const lead = leads && leads[0]
  if (!lead) return NextResponse.json({ ok: true, matched: false })

  const alreadyConverted = lead.status === 'convertido' || lead.status === 'cliente_recurrente'
  const labelChanged = ((lead.etiqueta_wa as string | null) || null) !== etiqueta
  const needConvert = isConverted && !alreadyConverted

  if (!labelChanged && !needConvert) {
    return NextResponse.json({ ok: true, matched: true, changed: false })
  }

  const nowIso = new Date().toISOString()
  const updates: Record<string, unknown> = {}
  if (labelChanged) updates.etiqueta_wa = etiqueta
  if (needConvert) {
    updates.status = 'convertido'
    updates.status_changed_at = nowIso
  }
  await supabase.from('leads').update(updates).eq('id', lead.id)

  if (labelChanged) {
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'wa_label',
      descripcion: `🏷️ Etiqueta WhatsApp: ${etiqueta || '(sin etiqueta)'}`,
      metadata: { source: 'wa_bridge', labels },
    })
  }
  if (needConvert) {
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'status_change',
      descripcion: `🎉 Convertido por etiqueta WhatsApp: ${etiqueta}`,
      metadata: { source: 'wa_bridge', convert_label: true, labels },
    })
  }
  return NextResponse.json({ ok: true, matched: true, changed: true, etiqueta, converted: needConvert })
}
