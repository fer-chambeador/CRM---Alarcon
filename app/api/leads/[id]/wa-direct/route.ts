import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { sendViaWaBridge, waDirectTemplate } from '@/lib/waBridge'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/leads/[id]/wa-direct
 *
 * Manda la MISMA plantilla del outbound pero desde el WhatsApp de Fer
 * (WA Bridge), no por Vambe. Se dispara desde el popup "¿Por dónde lo
 * quieres mandar?" del botón Mensaje — 1×1, siempre detonado por Fer.
 *
 * Mismos guards que quick-action 'message':
 *   - anti doble-click con lock optimistic en lead_actividad (2 min)
 *   - status nuevo→contactado + ultimo_contacto + veces_contactado
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const { data: leadRow, error } = await supabase
    .from('leads').select('*').eq('id', params.id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!leadRow) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })
  const lead = leadRow as Lead

  if (!lead.telefono) return NextResponse.json({ error: 'lead sin teléfono' }, { status: 400 })

  // Anti doble-click — comparte ventana con los sends de Vambe para que no
  // se pueda mandar Vambe + WA directo al mismo lead en <2 min por error.
  const since = new Date(Date.now() - 120_000).toISOString()
  const { data: recentSends } = await supabase
    .from('lead_actividad')
    .select('id')
    .eq('lead_id', lead.id)
    .in('tipo', ['template_sent', 'template_send_started', 'wa_direct_send_started', 'wa_direct_sent'])
    .gte('created_at', since)
    .limit(1)
  if (recentSends && recentSends.length > 0) {
    return NextResponse.json({ ok: false, error: 'mensaje ya enviado recientemente (anti doble-click)' }, { status: 409 })
  }

  const { data: lockRow, error: lockErr } = await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'wa_direct_send_started',
    descripcion: '📱 Enviando por WhatsApp de Fer (WA Bridge)…',
    metadata: { source: 'leads_channel_popup' },
  }).select('id').single()
  if (lockErr || !lockRow) {
    return NextResponse.json({ ok: false, error: 'No se pudo iniciar el envío' }, { status: 500 })
  }
  const lockId = (lockRow as { id: string }).id

  const empresa = lead.empresa || lead.nombre || 'tu empresa'
  const text = waDirectTemplate(empresa)
  const result = await sendViaWaBridge(lead.telefono, text)

  if (!result.ok) {
    await supabase.from('lead_actividad').update({
      tipo: 'wa_direct_send_failed',
      descripcion: `⚠️ WA Bridge NO envió el mensaje: ${result.error}`,
      metadata: { source: 'leads_channel_popup', error: result.error },
    }).eq('id', lockId)
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 })
  }

  await supabase.from('lead_actividad').update({
    tipo: 'wa_direct_sent',
    descripcion: `📱 Plantilla enviada desde WhatsApp de Fer (empresa: ${empresa})`,
    metadata: { source: 'leads_channel_popup', to: result.to || lead.telefono },
  }).eq('id', lockId)

  const updates: Record<string, unknown> = {
    ultimo_contacto: new Date().toISOString(),
    veces_contactado: (lead.veces_contactado || 0) + 1,
  }
  if (lead.status === 'nuevo') {
    updates.status = 'contactado'
    updates.status_changed_at = new Date().toISOString()
  }
  const { data: updatedLead } = await supabase
    .from('leads').update(updates).eq('id', lead.id).select('*').single()

  return NextResponse.json({ ok: true, action: 'wa-direct', lead: updatedLead })
}
