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
    // Anti-doble-click: si ya hay un template_sent O template_send_started
    // en los últimos 2 min, este es probablemente un doble click. Abort
    // para no duplicar. Ventana ampliada del original 30s — 2 min cubre red
    // lenta + retry humano.
    //
    // SECURITY FIX (4 jun 2026): antes solo buscaba 'template_sent', pero
    // ese marker se insertaba DESPUÉS del send → dos clicks rápidos
    // (<300ms) ambos pasaban el guard y mandaban 2 mensajes al cliente.
    // Ahora insertamos PRIMERO un marker 'template_send_started' (lock
    // optimistic), hacemos el send, y al final actualizamos el row a
    // 'template_sent' (éxito) o 'template_send_failed' (error).
    const since = new Date(Date.now() - 120_000).toISOString()
    const { data: recentSends } = await supabase
      .from('lead_actividad')
      .select('id')
      .eq('lead_id', lead.id)
      .in('tipo', ['template_sent', 'template_send_started'])
      .gte('created_at', since)
      .limit(1)
    if (recentSends && recentSends.length > 0) {
      return NextResponse.json({ ok: false, error: 'mensaje ya enviado recientemente (anti doble-click)' }, { status: 409 })
    }
    // LOCK OPTIMISTIC: insertar marker ANTES del send. Si dos clicks llegan
    // <300ms, el segundo verá este marker y abortará. Si el send falla, lo
    // actualizamos a 'template_send_failed' al final.
    const { data: lockRow, error: lockErr } = await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'template_send_started',
      descripcion: `📨 Enviando template ${tpl.template_name}…`,
      metadata: { source: 'leads_quick_action', template_id: tpl.template_id, template_name: tpl.template_name },
    }).select('id').single()
    if (lockErr || !lockRow) {
      console.error('[quick-action] no se pudo insertar lock optimistic', lockErr)
      return NextResponse.json({ ok: false, error: 'No se pudo iniciar el envío' }, { status: 500 })
    }
    const lockId = (lockRow as { id: string }).id
    try {
      const result = await sendTemplate({
        phone: lead.telefono,
        templateId: tpl.template_id,
        data: { empresa: lead.empresa || lead.nombre || 'tu empresa' },
      })
      // BUG FIX (3 jun 2026 — 2da iteración tras caso gerardolara555):
      // Vambe puede retornar HTTP 200 con un error en el body (sin lanzar).
      // Si la respuesta NO indica éxito explícito, abortar antes de bumpear
      // el lead. Sin esto, el CRM marca "Contactado" pero el cliente nunca
      // recibe el mensaje, y Fer no sabe que falló.
      type VambeSendResult = {
        success?: boolean
        ok?: boolean
        status?: string
        error?: string | { message?: string }
        message?: string
        data?: { status?: string; error?: string }
      }
      const r = (result || {}) as VambeSendResult
      const explicitFail =
        r.success === false ||
        r.ok === false ||
        (typeof r.status === 'string' && /^(failed|error|rejected)/i.test(r.status)) ||
        (typeof r.data?.status === 'string' && /^(failed|error|rejected)/i.test(r.data.status)) ||
        !!r.error
      if (explicitFail) {
        const reason = typeof r.error === 'string' ? r.error
          : (r.error as { message?: string })?.message
          || r.message || r.data?.error || 'Vambe rechazó el envío sin lanzar HTTP error'
        // Actualizar el lock row con resultado de error (no insertar nuevo)
        await supabase.from('lead_actividad').update({
          tipo: 'template_send_failed',
          descripcion: `⚠️ Vambe NO envió el template (${tpl.template_name}): ${reason}`,
          metadata: { source: 'leads_quick_action', template_id: tpl.template_id, template_name: tpl.template_name, vambe_response: r },
        }).eq('id', lockId)
        return NextResponse.json({ ok: false, error: `Vambe rechazó: ${reason}`, vambe_response: r }, { status: 502 })
      }

      // Send OK — actualizar el lock row a 'template_sent' (no insertar nuevo).
      const { error: actErr } = await supabase.from('lead_actividad').update({
        tipo: 'template_sent',
        descripcion: `📨 Vambe ${tpl.template_name} (manual desde /leads)`,
        metadata: { source: 'leads_quick_action', template_id: tpl.template_id, template_name: tpl.template_name },
      }).eq('id', lockId)
      if (actErr) {
        console.error('[quick-action] update lock a template_sent falló', actErr)
        return NextResponse.json({ ok: false, error: `Mensaje enviado pero no se pudo registrar en CRM: ${actErr.message}` }, { status: 500 })
      }
      const updates: Record<string, unknown> = {
        ultimo_contacto: new Date().toISOString(),
        veces_contactado: (lead.veces_contactado || 0) + 1,
      }
      if (lead.status === 'nuevo') {
        updates.status = 'contactado'
        updates.status_changed_at = new Date().toISOString()
      }
      // Audit #5: retornar el lead actualizado para evitar el round-trip extra
      // del frontend (que antes hacía GET /api/leads/[id] tras este POST).
      const { data: updatedLead } = await supabase
        .from('leads')
        .update(updates)
        .eq('id', lead.id)
        .select('*')
        .single()
      return NextResponse.json({ ok: true, action: 'message', result, lead: updatedLead })
    } catch (e) {
      // El send tiró excepción — marcar el lock como failed para que el
      // anti-doble-click no quede "bloqueado" 2 minutos por un error.
      await supabase.from('lead_actividad').update({
        tipo: 'template_send_failed',
        descripcion: `⚠️ Excepción al enviar template: ${e instanceof Error ? e.message : String(e)}`,
        metadata: { source: 'leads_quick_action', template_id: tpl.template_id, error: e instanceof Error ? e.message : String(e) },
      }).eq('id', lockId)
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 })
    }
  }

  // action === 'call'
  // ── REGLA DURA: 1 LLAMADA POR LEAD MÁXIMO ──
  // Si el lead ya tiene CUALQUIER llamada previa (queued, dialing, completed,
  // failed, no_answer, voicemail) en cualquier momento, rechazamos. Solo si la
  // anterior está 'canceled' permitimos volver a llamar. Esto es la misma
  // regla que aplica /api/dapta/trigger — para no haber loops y respetar al
  // cliente. Bypass: ?force=1 (admin path).
  const url = new URL(req.url)
  const force = url.searchParams.get('force') === '1'
  if (!force) {
    const { data: prevAny } = await supabase
      .from('llamadas')
      .select('id, status, created_at')
      .eq('lead_id', lead.id)
      .not('status', 'in', '(canceled)')
      .order('created_at', { ascending: false })
      .limit(1)
    if (prevAny && prevAny.length > 0) {
      const p = prevAny[0] as { id: string; status: string; created_at: string }
      return NextResponse.json({
        ok: false,
        error: 'lead-already-called',
        detail: `Este lead ya tiene una llamada previa (status=${p.status}). Cancélala primero o pasa ?force=1.`,
        previous_llamada_id: p.id,
        previous_status: p.status,
      }, { status: 409 })
    }
  }
  // Anti-doble-click adicional: si hay llamada dialing/queued en los últimos
  // 2 minutos (ventana ampliada del original 60s), abort silencioso.
  const since120 = new Date(Date.now() - 120_000).toISOString()
  const { data: recentCalls } = await supabase
    .from('llamadas')
    .select('id')
    .eq('lead_id', lead.id)
    .in('status', ['dialing', 'queued', 'ringing', 'connected'])
    .gte('created_at', since120)
    .limit(1)
  if (recentCalls && recentCalls.length > 0) {
    return NextResponse.json({ ok: false, error: 'llamada ya disparada recientemente (anti doble-click)' }, { status: 409 })
  }
  // FIX (4 jun 2026): ANTES disparábamos Dapta y luego insertábamos la
  // fila en `llamadas`. Si el INSERT fallaba (DB hiccup), la llamada
  // estaba en curso pero NO había row en CRM → el webhook post-call
  // no encontraba la llamada y caía en fallback por teléfono.
  //
  // AHORA: insertar PRIMERO con status='queued', después disparar Dapta,
  // y al final actualizar a 'dialing' (éxito) o 'failed' (error).
  const { data: callRow, error: insertErr } = await supabase.from('llamadas').insert({
    lead_id: lead.id,
    to_number: lead.telefono,
    from_number: process.env.DAPTA_FROM_NUMBER || null,
    agent_name: process.env.DAPTA_AGENT_NAME_DEFAULT || 'Daniela',
    status: 'queued',
    triggered_by: 'leads_quick_action',
    trigger_reason: 'manual call from /leads',
  }).select('id').single()
  if (insertErr || !callRow) {
    return NextResponse.json({ ok: false, error: `No se pudo registrar la llamada: ${insertErr?.message || 'unknown'}` }, { status: 500 })
  }
  const callId = (callRow as { id: string }).id

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
  await supabase.from('llamadas').update({
    status: tr.ok ? 'dialing' : 'failed',
    error_message: tr.ok ? null : (tr.error || 'unknown'),
  }).eq('id', callId)
  if (tr.ok) {
    const ADVANCED = new Set(['llamada_con_dapta','no_show_llamada','presentacion_enviada','espera_aprobacion','liga_pago_enviada','convertido','cliente_recurrente'])
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
  // Audit #5: incluir el lead actualizado para evitar 2do fetch del frontend
  const { data: updatedLead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', lead.id)
    .single()
  return NextResponse.json({ ok: tr.ok, action: 'call', dapta: tr, lead: updatedLead })
}
