import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { sendMessage } from '@/lib/vambe'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/leads/[id]/reactivate-vambe-3d
 *
 * Manda un mensaje de reactivación a leads que:
 *  - tienen canal Vambe (vambe_contact_id NOT NULL o canal_adquisicion incluye 'vambe')
 *  - llevan >= 3 días sin contacto
 *
 * El mensaje es texto plano enviado por Vambe sendMessage() (no template).
 * Soft-coded el copy aquí para iteración rápida sin tener que crear template
 * de Vambe aprobado por Meta.
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

  // ── Validar que sea lead de Vambe ─────────────────────────────────
  const canal = (lead.canal_adquisicion || '').toLowerCase()
  const isVambe = !!lead.vambe_contact_id || canal.includes('vambe') || canal.includes('whatsapp')
  if (!isVambe) {
    return NextResponse.json({
      ok: false,
      error: 'lead no es de canal Vambe — botón solo aplica a leads que vinieron por Vambe/WhatsApp',
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

  // ── Construir mensaje ─────────────────────────────────────────────
  // Copy alineado con la reactivación automática de Vambe (etapa Lanzamiento),
  // sin "o ya lo resolviste" y sin emoji bullet. Sustituye {nombre} con primer
  // nombre real si lo tenemos.
  const primerNombre = (lead.nombre || '').trim().split(/\s+/)[0] || ''
  const saludo = primerNombre ? `Hola ${primerNombre}` : 'Hola'
  const message = `${saludo} 👋 Te escribí hace unos días sobre ChambasAI pero no he sabido de ti. ¿Sigues buscando personal? Con un sí/no me alineo.`

  // ── Enviar via Vambe ──────────────────────────────────────────────
  try {
    const result = await sendMessage({
      phone: lead.telefono,
      message,
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
        metadata: { source: 'leads_reactivate_3d', vambe_response: r, message },
      }).eq('id', lockId)
      return NextResponse.json({ ok: false, error: `Vambe rechazó: ${reason}`, vambe_response: r }, { status: 502 })
    }

    // Send OK
    await supabase.from('lead_actividad').update({
      tipo: 'reactivate_3d_sent',
      descripcion: `📨 Plantilla Vambe outbound >3d (manual desde CRM)`,
      metadata: { source: 'leads_reactivate_3d', message },
    }).eq('id', lockId)

    const updates: Record<string, unknown> = {
      ultimo_contacto: new Date().toISOString(),
      veces_contactado: (lead.veces_contactado || 0) + 1,
    }
    // No movemos status — el lead sigue en su etapa. Solo registramos contacto.

    const { data: updatedLead } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', lead.id)
      .select('*')
      .single()

    return NextResponse.json({
      ok: true,
      action: 'reactivate_3d',
      message_sent: message,
      lead: updatedLead,
    })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    await supabase.from('lead_actividad').update({
      tipo: 'reactivate_3d_failed',
      descripcion: `⚠️ Excepción al enviar plantilla outbound >3d: ${errMsg}`,
      metadata: { source: 'leads_reactivate_3d', error: errMsg, message },
    }).eq('id', lockId)
    return NextResponse.json({ ok: false, error: errMsg }, { status: 502 })
  }
}
