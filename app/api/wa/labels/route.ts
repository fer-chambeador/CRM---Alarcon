import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * POST /api/wa/labels  { phone: string, labels: string[] }
 *
 * El WA Bridge reporta las etiquetas de WhatsApp Business de un chat 1:1.
 * Matcheamos el lead por los ultimos 10 digitos del telefono y:
 *  1) guardamos las etiquetas (texto) en leads.etiqueta_wa.
 *  2) movemos la ETAPA del lead segun el mapeo etiqueta→status (abajo).
 *
 * La etapa objetivo es la de mayor precedencia entre las etiquetas del chat.
 * Nunca degrada un lead ya ganado (convertido / cliente_recurrente), salvo a
 * otro estado terminal (descartado). Idempotente: si nada cambia NO escribe.
 *
 * Auth: header x-bridge-secret == WA_BRIDGE_SECRET (mismo valor que el bridge).
 */

const norm = (s: string) => s.trim().toLowerCase()

// Etiqueta WhatsApp Business (normalizada) → status del CRM.
const LABEL_STAGE: Record<string, string> = {
  'lead inbound': 'contactado',
  'llamada pendiente': 'llamada_agendada',
  'demo': 'llamada_agendada',
  'propuesta enviada': 'presentacion_enviada',
  'liga de pago': 'liga_pago_enviada',
  'liga de pago enviada': 'liga_pago_enviada',
  'espera de aprobacion': 'espera_aprobacion',
  'espera de aprobación': 'espera_aprobacion',
  'ghosting llamada': 'no_show_llamada',
  'rechazado': 'descartado',
  'cliente pagando': 'convertido',
  'cliente / renovar': 'cliente_recurrente',
  'renovar': 'cliente_recurrente',
  // Informativas (Vambe, $5000, $1160, Ro…) NO están aquí a propósito:
  // se guardan en etiqueta_wa pero no cambian la etapa.
}

// Precedencia de etapas: gana la más avanzada.
const RANK: Record<string, number> = {
  nuevo: 1, contactado: 2, llamada_agendada: 3, no_show_llamada: 4,
  presentacion_enviada: 5, espera_aprobacion: 6, liga_pago_enviada: 7,
  descartado: 8, cliente_recurrente: 9, convertido: 10,
}
const WON = new Set(['convertido', 'cliente_recurrente'])
const TERMINAL_OK = new Set(['convertido', 'cliente_recurrente', 'descartado'])

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

  // Etapa objetivo = la de mayor rank entre las etiquetas mapeadas del chat.
  let best: string | null = null
  for (const l of labels) {
    const st = LABEL_STAGE[norm(l)]
    if (st && (!best || (RANK[st] || 0) > (RANK[best] || 0))) best = st
  }

  const supabase = createServiceClient()
  const { data: leads } = await supabase
    .from('leads')
    .select('id, etiqueta_wa, status')
    .ilike('telefono', `%${digits}`)
    .limit(1)
  const lead = leads && leads[0]
  if (!lead) return NextResponse.json({ ok: true, matched: false })

  const current = String(lead.status || '')
  const labelChanged = ((lead.etiqueta_wa as string | null) || null) !== etiqueta

  // ¿Mover etapa? Solo si mapea a algo distinto y no degrada un lead ganado.
  let newStatus: string | null = null
  if (best && best !== current) {
    const protectWon = WON.has(current) && !TERMINAL_OK.has(best)
    if (!protectWon) newStatus = best
  }

  if (!labelChanged && !newStatus) {
    return NextResponse.json({ ok: true, matched: true, changed: false })
  }

  const nowIso = new Date().toISOString()
  const updates: Record<string, unknown> = {}
  if (labelChanged) updates.etiqueta_wa = etiqueta
  if (newStatus) { updates.status = newStatus; updates.status_changed_at = nowIso }
  await supabase.from('leads').update(updates).eq('id', lead.id)

  if (labelChanged) {
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'wa_label',
      descripcion: `🏷️ Etiqueta WhatsApp: ${etiqueta || '(sin etiqueta)'}`,
      metadata: { source: 'wa_bridge', labels },
    })
  }
  if (newStatus) {
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'status_change',
      descripcion: `🔄 Etapa por etiqueta WhatsApp: ${current || '(nuevo)'} → ${newStatus}`,
      metadata: { source: 'wa_bridge', label_stage: true, labels, from: current, to: newStatus },
    })
  }
  return NextResponse.json({ ok: true, matched: true, changed: true, etiqueta, status: newStatus || current })
}
