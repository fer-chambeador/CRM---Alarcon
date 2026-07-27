import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * POST /api/wa/inbound
 *
 * El WA Bridge (tu WhatsApp) reporta CADA mensaje del chat 1:1 — entrante
 * (te escriben) y saliente (tú respondes). Con eso el CRM refleja en tiempo
 * real que ese lead ya está en conversación contigo, para que el outbound
 * automático NO le mande "primer contacto".
 *
 * Reglas (acordadas con Fer):
 *  - Lead que YA existe → ultimo_contacto = ahora; si está en 'nuevo' → 'contactado'.
 *  - Lead que NO existe → se crea SOLO si la conversación avanzó = tú respondiste
 *    (fromMe=true). Un mensaje entrante suelto (posible candidato) no crea lead.
 *  - Nivel: estado + último contacto (no guardamos el texto).
 *
 * Auth: header x-bridge-secret == WA_BRIDGE_SECRET (mismo valor que el bridge).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.WA_BRIDGE_SECRET || ''
  if (!secret || req.headers.get('x-bridge-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: { phone?: string; fromMe?: boolean } = {}
  try { body = await req.json() } catch { /* body vacío */ }

  const rawPhone = String(body.phone || '')
  const digits = rawPhone.replace(/[^0-9]/g, '').slice(-10)
  if (digits.length !== 10) return NextResponse.json({ ok: false, error: 'phone inválido' })
  const fromMe = !!body.fromMe

  const supabase = createServiceClient()
  const nowIso = new Date().toISOString()

  // Buscar lead por los últimos 10 dígitos (soporta formatos +52…, 52…, 521…)
  const { data: leads } = await supabase
    .from('leads')
    .select('id,status')
    .ilike('telefono', `%${digits}`)
    .limit(1)
  const lead = leads && leads[0]

  if (lead) {
    const updates: Record<string, unknown> = { ultimo_contacto: nowIso }
    if (lead.status === 'nuevo') {
      updates.status = 'contactado'
      updates.status_changed_at = nowIso
    }
    await supabase.from('leads').update(updates).eq('id', lead.id)
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'wa_inbound_sync',
      descripcion: fromMe
        ? '📤 Le escribiste por WhatsApp (WA Bridge)'
        : '📥 Te escribió por WhatsApp (WA Bridge)',
      metadata: { source: 'wa_bridge_sync', direction: fromMe ? 'out' : 'in' },
    })
    return NextResponse.json({ ok: true, matched: true, leadId: lead.id })
  }

  // No existe lead. Crear SOLO si tú respondiste (conversación avanzó).
  if (!fromMe) return NextResponse.json({ ok: true, matched: false, created: false })

  const email = `${digits}@whatsapp.chambas.ai`
  const exq = await supabase.from('leads').select('id').eq('email', email).limit(1).maybeSingle()
  if (exq.data?.id) return NextResponse.json({ ok: true, matched: true, leadId: exq.data.id })

  const ins = await supabase
    .from('leads')
    .insert({
      email,
      telefono: rawPhone,
      canal_adquisicion: 'WhatsApp directo',
      status: 'contactado',
      status_changed_at: nowIso,
      ultimo_contacto: nowIso,
    })
    .select('id')
    .single()
  if (ins.error) return NextResponse.json({ ok: false, error: ins.error.message })
  await supabase.from('lead_actividad').insert({
    lead_id: ins.data.id,
    tipo: 'wa_inbound_sync',
    descripcion: '🆕 Lead creado desde tu WhatsApp (conversación activa)',
    metadata: { source: 'wa_bridge_sync', created: true },
  })
  return NextResponse.json({ ok: true, matched: false, created: true, leadId: ins.data.id })
}
