import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { sendTemplate } from '@/lib/vambe'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * Template Vambe `reactivacion_3d_chambasai` aprobado por Meta (8-jun-2026).
 * Copy fijo: "Hola Lic, te escribí hace unos días sobre ChambasAI 👋 No te
 * preocupes si andas a mil — solo dime: ¿sigues buscando personal? Si es así
 * podemos ayudarte a reclutar por solo $1160" + 2 quick reply buttons:
 *  - "Sí necesito personal"
 *  - "Ya no, muchas gracias"
 *
 * El template_id se puede sobrescribir con env var REACTIVATION_3D_TEMPLATE_ID
 * por si Vambe regenera el ID en el futuro (raro pero por si).
 */
const REACTIVATION_3D_TEMPLATE_ID = process.env.REACTIVATION_3D_TEMPLATE_ID
  || '8f364ab3-9dea-4892-85b2-f1b0a9ff3fca'

/**
 * Stage UUID de "Interesado" en el pipeline de Vambe.
 *
 * BUG FIX (17-jun-2026): cuando un lead está en "Asistencia Humana", Vambe
 * desactiva la IA y los quick-reply buttons NO disparan ningún asistente
 * (caso Claudia Valenzuela: respondió "Sí necesito personal" y nada se
 * activó). El sendTemplate de Vambe acepta `stage` en query para mover
 * el contacto AL momento de enviar el template — así cuando responda al
 * quick reply, ya estará en "Interesado" donde el asistente Outbound /
 * Interesado Agendador SÍ están activos.
 *
 * Puede sobrescribirse con env var por si Fer recablea el pipeline.
 */
const REACTIVATION_3D_TARGET_STAGE = process.env.REACTIVATION_3D_TARGET_STAGE
  || '96c42cda-2828-45db-973c-3bc63a8141fd' // Interesado

/**
 * POST /api/leads/[id]/reactivate-vambe-3d
 *
 * Manda el template `reactivacion_3d_chambasai` a leads que:
 *  - canal_adquisicion contiene "vambe" (STRICT — no whatsapp ni otros)
 *  - llevan >= 3 días sin contacto
 *  - status no terminal
 *
 * Botón en CRM (LeadDetailClient + LeadModal) confirma con el user antes
 * de llamar este endpoint.
 *
 * Idempotente vs. doble-click: anti-doble (2 min window, mismo patrón que
 * /quick-action). Si el lead NO califica (no vambe / <3 días), retorna 422.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const { data: leadRow, error } = await supabase
    .from('leads').select('*').eq('id', params.id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!leadRow) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })
  const lead = leadRow as Lead

  if (!lead.telefono) {
    return NextResponse.json({ error: 'lead sin teléfono' }, { status: 400 })
  }

  // ── Validar que sea lead de Vambe (STRICT) ────────────────────────
  // Fer (8-jun-2026): "esa plantilla solo se puede detonar a leads que vengan
  // de Vambe". Antes el check era laxo (vambe_contact_id OR whatsapp), ahora
  // solo aceptamos canal_adquisicion que contenga 'vambe'.
  const canal = (lead.canal_adquisicion || '').toLowerCase()
  if (!canal.includes('vambe')) {
    return NextResponse.json({
      ok: false,
      error: 'lead no es de canal Vambe — la plantilla reactivacion_3d_chambasai solo aplica a leads que vinieron por Vambe',
    }, { status: 422 })
  }

  // ── Validar >= 3 días sin contacto ────────────────────────────────
  if (lead.ultimo_contacto) {
    const ms = Date.now() - new Date(lead.ultimo_contacto).getTime()
    const days = ms / 86_400_000
    if (days < 3) {
      return NextResponse.json({
        ok: false,
        error: `lead contactado hace ${days.toFixed(1)} días — la plantilla outbound >3d aplica solo a leads con ≥3 días de silencio`,
      }, { status: 422 })
    }
  }
  // si ultimo_contacto es null, dejamos pasar (lead nunca contactado, igual aplica)

  // ── Anti-doble-click (mismo patrón que /quick-action) ─────────────
  const since = new Date(Date.now() - 120_000).toISOString()
  const { data: recentSends } = await supabase
    .from('lead_actividad')
    .select('id')
    .eq('lead_id', lead.id)
    .in('tipo', ['reactivate_3d_sent', 'reactivate_3d_started', 'template_send_started', 'template_sent'])
    .gte('created_at', since)
    .limit(1)
  if (recentSends && recentSends.length > 0) {
    return NextResponse.json({
      ok: false,
      error: 'mensaje ya enviado recientemente (anti doble-click)',
    }, { status: 409 })
  }

  // ── Lock optimistic ───────────────────────────────────────────────
  const { data: lockRow, error: lockErr } = await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'reactivate_3d_started',
    descripcion: `📨 Enviando plantilla Vambe outbound >3d…`,
    metadata: { source: 'leads_reactivate_3d' },
  }).select('id').single()
  if (lockErr || !lockRow) {
    return NextResponse.json({ ok: false, error: 'No se pudo iniciar el envío' }, { status: 500 })
  }
  const lockId = (lockRow as { id: string }).id

  // ── Enviar template aprobado por Meta ─────────────────────────────
  // El copy del template es FIJO en Vambe (aprobado por Meta). NO lleva
  // variables — empieza con "Hola Lic" (no personalizado). Los 2 quick reply
  // buttons "Sí necesito personal" / "Ya no, muchas gracias" están definidos
  // en el template y los maneja el asistente Outbound (ver prompt).
  try {
    // BUG FIX (17-jun-2026): pasamos `stageId` para que Vambe mueva el
    // contacto a "Interesado" antes de enviar el template. Sin esto, los
    // leads en "Asistencia Humana" no respondían al quick reply porque la
    // IA estaba desactivada (caso Claudia Valenzuela).
    const result = await sendTemplate({
      phone: lead.telefono,
      templateId: REACTIVATION_3D_TEMPLATE_ID,
      stageId: REACTIVATION_3D_TARGET_STAGE,
    })

    // Validar respuesta — Vambe puede devolver 200 con error en body
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
        || r.message || r.data?.error || 'Vambe rechazó el envío'
      await supabase.from('lead_actividad').update({
        tipo: 'reactivate_3d_failed',
        descripcion: `⚠️ Vambe NO envió la plantilla outbound >3d: ${reason}`,
        metadata: { source: 'leads_reactivate_3d', vambe_response: r, template_id: REACTIVATION_3D_TEMPLATE_ID },
      }).eq('id', lockId)
      return NextResponse.json({ ok: false, error: `Vambe rechazó: ${reason}`, vambe_response: r }, { status: 502 })
    }

    // Send OK
    await supabase.from('lead_actividad').update({
      tipo: 'reactivate_3d_sent',
      descripcion: `📨 Plantilla Vambe reactivacion_3d_chambasai (manual desde CRM)`,
      metadata: { source: 'leads_reactivate_3d', template_id: REACTIVATION_3D_TEMPLATE_ID, template_name: 'reactivacion_3d_chambasai' },
    }).eq('id', lockId)

    const updates: Record<string, unknown> = {
      ultimo_contacto: new Date().toISOString(),
      veces_contactado: (lead.veces_contactado || 0) + 1,
    }
    // FIX (8-jun-2026, Fer): "se actualiza a '1er contacto' pero no cambia de
    // Nuevo a Contactado". Si el lead estaba en status 'nuevo' y le mandamos
    // el template, ya hubo un contacto outbound → debe moverse a 'contactado'.
    // Mismo comportamiento que /quick-action 'message' (line 135-138).
    // NO movemos a etapas más avanzadas (eso lo hace el Outbound asistente
    // cuando el lead responde al quick reply).
    if (lead.status === 'nuevo') {
      updates.status = 'contactado'
      updates.status_changed_at = new Date().toISOString()
    }

    const { data: updatedLead } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', lead.id)
      .select('*')
      .single()

    return NextResponse.json({
      ok: true,
      action: 'reactivate_3d',
      template_id: REACTIVATION_3D_TEMPLATE_ID,
      lead: updatedLead,
    })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    await supabase.from('lead_actividad').update({
      tipo: 'reactivate_3d_failed',
      descripcion: `⚠️ Excepción al enviar plantilla outbound >3d: ${errMsg}`,
      metadata: { source: 'leads_reactivate_3d', error: errMsg, template_id: REACTIVATION_3D_TEMPLATE_ID },
    }).eq('id', lockId)
    return NextResponse.json({ ok: false, error: errMsg }, { status: 502 })
  }
}
