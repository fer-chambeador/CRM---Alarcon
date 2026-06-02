import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { sendTemplate } from '@/lib/vambe'
import { triggerDaptaCall } from '@/lib/dapta'
import { getOutboundTemplate } from '@/lib/systemSettings'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

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

  // LOCK OPTIMISTA: marcar como 'approved' atomically con condición
  // `status='pending'` en el WHERE. Si dos requests llegan en paralelo,
  // solo el primero gana el UPDATE (rows=1); el segundo recibe rows=0
  // y aborta sin disparar Vambe/Dapta de nuevo.
  const { data: lockRows } = await supabase
    .from('aprobaciones')
    .update({
      status: 'approved',
      decided_at: new Date().toISOString(),
    })
    .eq('id', a.id)
    .eq('status', 'pending')
    .select('id')
  if (!lockRows || lockRows.length === 0) {
    return NextResponse.json({ ok: false, error: 'aprobación ya fue procesada (race condition)' }, { status: 409 })
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

  // ── Normalizar el teléfono (defensa en profundidad) ──
  // Mismo fix que /api/dapta/trigger (2 jun 2026): si el lead viene con
  // teléfono malformado (formato MX viejo +5201…, espacios, etc.) Vambe
  // o Dapta no podrán contactarlo y la fila quedará stuck. Normalizamos
  // antes y persistimos el canónico en lead.telefono.
  const phoneNormalized = normalizeMexicanPhone(lead.telefono)
  if (!phoneNormalized) {
    await supabase.from('aprobaciones').update({
      status: 'failed',
      error_message: `Teléfono inválido: '${lead.telefono}'. Edítalo manualmente.`,
      decided_at: new Date().toISOString(),
    }).eq('id', a.id)
    return NextResponse.json({ ok: false, error: 'telefono-no-valido', detail: `El teléfono '${lead.telefono}' no se pudo normalizar.` }, { status: 400 })
  }
  if (phoneNormalized !== lead.telefono) {
    await supabase.from('leads').update({ telefono: phoneNormalized }).eq('id', lead.id)
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'field_change',
      descripcion: `Teléfono normalizado: ${lead.telefono} → ${phoneNormalized}`,
      metadata: { field: 'telefono', before: lead.telefono, after: phoneNormalized, source: 'aprobacion_approve_auto_normalize' },
    })
    lead.telefono = phoneNormalized
  }

  // 2. Ejecutar según tipo
  try {
    if (a.tipo === 'vambe_template') {
      // Resolver template: DB setting > env var > fila a.template_id (legacy).
      // Si el user cambia el template en Settings, las nuevas aprobaciones usan el nuevo.
      const dbTemplate = await getOutboundTemplate(supabase)
      const templateId = dbTemplate?.template_id || a.template_id || process.env.VAMBE_AGENDA_TEMPLATE_ID
      const templateName = dbTemplate?.template_name || a.template_name || 'outbound_primer_mensaje_sales'
      if (!templateId) {
        await supabase.from('aprobaciones').update({
          status: 'failed',
          error_message: 'Template Vambe no configurado. Ve a Settings → Templates outbound.',
          decided_at: new Date().toISOString(),
        }).eq('id', a.id)
        return NextResponse.json({ ok: false, error: 'template no configurado' }, { status: 500 })
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
        descripcion: `📨 Mensaje Vambe enviado: ${templateName}`,
        metadata: { source: 'aprobacion', aprobacion_id: a.id, template_id: templateId, template_name: templateName },
      })

      return NextResponse.json({ ok: true, tipo: 'vambe_template', result })
    }

    if (a.tipo === 'dapta_call') {
      // ── REGLA DURA: 1 LLAMADA POR LEAD MÁXIMO (con bypass por password) ──
      // Aplica también al flujo de aprobaciones: si el lead ya tiene cualquier
      // otra llamada (no canceled), rechazamos para no marcar 2 veces. Esto
      // protege el caso donde Fer aprueba 2 items del mismo lead por error.
      //
      // BYPASS: el frontend puede mandar { force: true, password: '1234' } en
      // el body. Si el password matchea DAPTA_FORCE_CALL_PASSWORD (default
      // '1234'), se permite re-llamar al lead.
      const bodyTyped = body as { dapta_immediate?: boolean; force?: boolean; password?: string }
      const forceCall = !!bodyTyped.force
      if (forceCall) {
        const passExpected = process.env.DAPTA_FORCE_CALL_PASSWORD || '1234'
        if (bodyTyped.password !== passExpected) {
          // Revertir el lock optimista
          await supabase.from('aprobaciones').update({ status: 'pending', decided_at: null }).eq('id', a.id)
          return NextResponse.json({
            ok: false,
            error: 'force-password-required',
            detail: 'Para re-llamar a un lead con llamada previa necesitas el password correcto.',
          }, { status: 401 })
        }
      }

      if (!forceCall) {
        const { data: prevCall } = await supabase
          .from('llamadas')
          .select('id, status, created_at')
          .eq('lead_id', lead.id)
          .not('status', 'in', '(canceled)')
          .order('created_at', { ascending: false })
          .limit(1)
        if (prevCall && prevCall.length > 0) {
          const p = prevCall[0] as { id: string; status: string; created_at: string }
          // Revertir el lock optimista — volver el aprobación a pending para que el
          // user pueda decidir (rechazar manualmente o cancelar la llamada previa).
          await supabase.from('aprobaciones').update({
            status: 'pending',
            decided_at: null,
          }).eq('id', a.id)
          return NextResponse.json({
            ok: false,
            error: 'lead-already-called',
            detail: `Este lead ya tiene una llamada previa (status=${p.status}, llamada_id=${p.id}). Captura el password para forzar re-llamar.`,
            previous_llamada_id: p.id,
            previous_status: p.status,
          }, { status: 409 })
        }
      }

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
