import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { sendTemplate } from '@/lib/vambe'
import { triggerDaptaCall } from '@/lib/dapta'
import { getOutboundTemplate } from '@/lib/systemSettings'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/leads/[id]/quick-action
 * Body: { action: 'call' | 'message' }
 *
 * Atajo desde la tabla de Leads — dispara la misma lógica que el flow Outbound
 * pero sin pasar por aprobación. El user clickeó directamente, no hace falta
 * aprobación adicional.
 *
 *  - 'message': manda Vambe template outbound (mismo que /outbound) + cambia
 *    lead.status nuevo→contactado.
 *  - 'call': dispara Daniela ya + crea row en `llamadas` + mueve lead a
 *    llamada_con_dapta.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => null) as { action?: 'call' | 'message' } | null
  if (!body?.action || !['call', 'message'].includes(body.action)) {
    return NextResponse.json({ error: 'action debe ser call|message' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: leadRow, error } = await supabase
    .from('leads').select('*').eq('id', params.id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!leadRow) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })
  const lead = leadRow as Lead

  if (!lead.telefono) {
    return NextResponse.json({ error: 'lead sin teléfono' }, { status: 400 })
  }

  if (body.action === 'message') {
    const tpl = await getOutboundTemplate(supabase)
    if (!tpl?.template_id) {
      return NextResponse.json({ error: 'Template Vambe no configurado. Ve a Settings.' }, { status: 500 })
    }
    // Anti-doble-click: si ya hay un template_sent en los últimos 30s,
    // este es probablemente un doble click. Abort para no duplicar.
    const since = new Date(Date.now() - 30_000).toISOString()
    const { data: recentSends } = await supabase
      .from('lead_actividad')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('tipo', 'template_sent')
      .gte('created_at', since)
      .limit(1)
    if (recentSends && recentSends.length > 0) {
      return NextResponse.json({ ok: false, error: 'mensaje ya enviado recientemente (anti doble-click)' }, { status: 409 })
    }
    try {
      const result = await sendTemplate({
        phone: lead.telefono,
        templateId: tpl.template_id,
        data: { empresa: lead.empresa || lead.nombre || 'tu empresa' },
      })
      if (lead.status === 'nuevo') {
        await supabase.from('leads').update({
          status: 'contactado',
          status_changed_at: new Date().toISOString(),
          veces_contactado: (lead.veces_contactado || 0) + 1,
        }).eq('id', lead.id)
      }
      await supabase.from('lead_actividad').insert({
        lead_id: lead.id,
        tipo: 'template_sent',
        descripcion: `📨 Vambe ${tpl.template_name} (manual desde /leads)`,
        metadata: { source: 'leads_quick_action', template_id: tpl.template_id, template_name: tpl.template_name },
      })
      return NextResponse.json({ ok: true, action: 'message', result })
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 })
    }
  }

  // action === 'call'
  // Anti-doble-click: si hay llamada dialing/queued en los últimos 60s, abort.
  const since60 = new Date(Date.now() - 60_000).toISOString()
  const { data: recentCalls } = await supabase
    .from('llamadas')
    .select('id')
    .eq('lead_id', lead.id)
    .in('status', ['dialing', 'queued', 'ringing', 'connected'])
    .gte('created_at', since60)
    .limit(1)
  if (recentCalls && recentCalls.length > 0) {
    return NextResponse.json({ ok: false, error: 'llamada ya disparada recientemente (anti doble-click)' }, { status: 409 })
  }
  const tr = await triggerDaptaCall({
    lead_id: lead.id,
    to_number: lead.telefono,
    nombre: lead.nombre,
    empresa: lead.empresa,
    vacante: lead.vacante,
    presupuesto: lead.presupuesto,
    puesto: lead.puesto,
    notas: lead.notas,
  })
  await supabase.from('llamadas').insert({
    lead_id: lead.id,
    to_number: lead.telefono,
    from_number: process.env.DAPTA_FROM_NUMBER || null,
    agent_name: process.env.DAPTA_AGENT_NAME_DEFAULT || 'Daniela',
    status: tr.ok ? 'dialing' : 'failed',
    triggered_by: 'leads_quick_action',
    trigger_reason: 'manual call from /leads',
    error_message: tr.ok ? null : (tr.error || 'unknown'),
  })
  if (tr.ok) {
    const ADVANCED = new Set(['llamada_con_dapta','no_show_llamada','presentacion_enviada','espera_aprobacion','convertido','cliente_recurrente'])
    if (!ADVANCED.has(lead.status)) {
      await supabase.from('leads').update({
        status: 'llamada_con_dapta',
        status_changed_at: new Date().toISOString(),
      }).eq('id', lead.id)
    }
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'dapta_call_triggered',
      descripcion: `📞 Llamada Dapta disparada (manual desde /leads)`,
      metadata: { source: 'leads_quick_action' },
    })
  }
  return NextResponse.json({ ok: tr.ok, action: 'call', dapta: tr })
}
