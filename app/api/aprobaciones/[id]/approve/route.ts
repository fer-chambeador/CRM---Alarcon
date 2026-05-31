import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { sendTemplate } from '@/lib/vambe'
import { triggerDaptaCall } from '@/lib/dapta'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/aprobaciones/[id]/approve
 *
 * Body: { dapta_immediate?: boolean } — para dapta_call, default false (agendar).
 *
 * Comportamiento por tipo:
 *  - vambe_template: dispara sendTemplate({ phone, templateId, data:{ empresa } }).
 *    Cambia lead.status nuevo→contactado.
 *  - dapta_call: crea fila en `llamadas` con scheduled_at = lead.llamada_at - 5min
 *    si dapta_immediate=false, sino dispara ya. Mueve lead a llamada_con_dapta.
 *
 * Idempotente: si la aprobación ya está approved/failed, devuelve el estado.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const body = await req.json().catch(() => ({})) as { dapta_immediate?: boolean }

  // 1. Buscar la aprobación
  const { data: apro, error } = await supabase
    .from('aprobaciones')
    .select(`*, leads:lead_id (*)`)
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!apro) return NextResponse.json({ error: 'aprobación no encontrada' }, { status: 404 })

  const a = apro as {
    id: string
    tipo: 'vambe_template' | 'dapta_call'
    status: string
    lead_id: string
    template_id: string | null
    template_name: string | null
    scheduled_at: string | null
    leads: Lead | null
  }

  if (a.status !== 'pending') {
    return NextResponse.json({ ok: false, error: `aprobación ya está en estado '${a.status}'`, current: a })
  }
  if (!a.leads) {
    return NextResponse.json({ error: 'lead asociado no encontrado' }, { status: 404 })
  }
  const lead = a.leads
  if (!lead.telefono) {
    await supabase.from('aprobaciones').update({
      status: 'failed',
      error_message: 'lead sin teléfono',
      decided_at: new Date().toISOString(),
    }).eq('id', a.id)
    return NextResponse.json({ ok: false, error: 'lead sin teléfono' }, { status: 400 })
  }

  // 2. Ejecutar según tipo
  try {
    if (a.tipo === 'vambe_template') {
      const templateId = a.template_id || process.env.VAMBE_AGENDA_TEMPLATE_ID
      if (!templateId) {
        await supabase.from('aprobaciones').update({
          status: 'failed',
          error_message: 'VAMBE_AGENDA_TEMPLATE_ID no configurado',
          decided_at: new Date().toISOString(),
        }).eq('id', a.id)
        return NextResponse.json({ ok: false, error: 'template_id no configurado' }, { status: 500 })
      }

      const result = await sendTemplate({
        phone: lead.telefono,
        templateId,
        data: { empresa: lead.empresa || lead.nombre || 'tu empresa' },
      })

      // Marcar aprobación + lead
      await supabase.from('aprobaciones').update({
        status: 'approved',
        result_metadata: { vambe_response: result },
        decided_at: new Date().toISOString(),
      }).eq('id', a.id)
      // Si el lead sigue en 'nuevo', avanzarlo a 'contactado'
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
        descripcion: `📨 Mensaje Vambe enviado: ${a.template_name || templateId}`,
        metadata: { source: 'aprobacion', aprobacion_id: a.id, template_id: templateId, template_name: a.template_name },
      })

      return NextResponse.json({ ok: true, tipo: 'vambe_template', result })
    }

    if (a.tipo === 'dapta_call') {
      // Si dapta_immediate=true → llamar ya. Si no, agendar a lead.llamada_at - 5min.
      const llamadaAt = lead.llamada_at ? new Date(lead.llamada_at).getTime() : null
      const scheduleMs = llamadaAt
        ? Math.max(llamadaAt - 5 * 60_000, Date.now() + 60_000)
        : Date.now() + 60_000
      const isImmediate = !!body.dapta_immediate

      if (isImmediate) {
        // Dispara YA: usar el helper de dapta, y crear fila en llamadas
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
          triggered_by: 'aprobacion',
          trigger_reason: 'approval queue (immediate)',
          error_message: tr.ok ? null : (tr.error || 'unknown'),
        })
      } else {
        // Agendar: crear fila en llamadas con status='queued' + scheduled_at
        await supabase.from('llamadas').insert({
          lead_id: lead.id,
          to_number: lead.telefono,
          from_number: process.env.DAPTA_FROM_NUMBER || null,
          agent_name: process.env.DAPTA_AGENT_NAME_DEFAULT || 'Daniela',
          status: 'queued',
          scheduled_at: new Date(scheduleMs).toISOString(),
          triggered_by: 'aprobacion',
          trigger_reason: 'approval queue (scheduled)',
        })
      }

      // Mover lead a llamada_con_dapta (si no está ya en algo más avanzado)
      const ADVANCED = new Set(['llamada_con_dapta','no_show_llamada','presentacion_enviada','espera_aprobacion','convertido','cliente_recurrente'])
      if (!ADVANCED.has(lead.status)) {
        await supabase.from('leads').update({
          status: 'llamada_con_dapta',
          status_changed_at: new Date().toISOString(),
        }).eq('id', lead.id)
      }

      await supabase.from('aprobaciones').update({
        status: 'approved',
        result_metadata: { immediate: isImmediate, scheduled_at: new Date(scheduleMs).toISOString() },
        decided_at: new Date().toISOString(),
      }).eq('id', a.id)
      await supabase.from('lead_actividad').insert({
        lead_id: lead.id,
        tipo: isImmediate ? 'dapta_call_triggered' : 'dapta_call_scheduled',
        descripcion: isImmediate
          ? `📞 Dapta call disparada desde aprobaciones`
          : `📅 Dapta call agendada para ${new Date(scheduleMs).toLocaleString('es-MX')}`,
        metadata: { source: 'aprobacion', aprobacion_id: a.id },
      })

      return NextResponse.json({ ok: true, tipo: 'dapta_call', immediate: isImmediate, scheduled_at: new Date(scheduleMs).toISOString() })
    }

    return NextResponse.json({ error: `tipo desconocido: ${a.tipo}` }, { status: 400 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await supabase.from('aprobaciones').update({
      status: 'failed',
      error_message: msg,
      decided_at: new Date().toISOString(),
    }).eq('id', a.id)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
