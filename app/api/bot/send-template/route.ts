import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { sendTemplate, listTemplates } from '@/lib/vambe'
import { requireBotAuth } from '../_lib/auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/bot/send-template
 *
 * Body: {
 *   lead_id: string,             // uuid del lead
 *   template_slug?: string,      // nombre del template (ej: 'agendar_llamada_v2')
 *   template_id?: string,        // OR: id directo del template
 *   stage_id?: string,           // opcional: mover a stage antes de enviar (BUG FIX 17-jun)
 *   data?: object,               // variables del template si aplica
 * }
 *
 * Auth: header x-bot-secret = env BOT_SECRET
 *
 * El slug se resuelve consultando listTemplates(). Se cachea la resolución
 * en memoria del módulo por 5 min para no llamar Vambe en cada envío.
 */

// Cache de templates por slug (5 min)
type TemplateCache = { at: number; byName: Map<string, string> }
let templateCache: TemplateCache | null = null
const CACHE_MS = 5 * 60 * 1000

async function resolveTemplateSlug(slug: string): Promise<string | null> {
  const now = Date.now()
  if (!templateCache || now - templateCache.at > CACHE_MS) {
    const { templates } = await listTemplates({ get_all: true, status: 'APPROVED' })
    const map = new Map<string, string>()
    for (const t of templates) {
      if (t.name && t.id) map.set(t.name.toLowerCase(), t.id)
    }
    templateCache = { at: now, byName: map }
  }
  return templateCache.byName.get(slug.toLowerCase()) || null
}

export async function POST(req: NextRequest) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  let body: {
    lead_id?: string
    template_slug?: string
    template_id?: string
    stage_id?: string
    data?: Record<string, unknown>
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const { lead_id, template_slug, template_id, stage_id, data } = body
  if (!lead_id) return NextResponse.json({ error: 'lead_id requerido' }, { status: 400 })
  if (!template_slug && !template_id) {
    return NextResponse.json({ error: 'template_slug o template_id requerido' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: lead, error: leadErr } = await supabase
    .from('leads').select('*').eq('id', lead_id).maybeSingle()

  if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 })
  if (!lead) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })
  if (!lead.telefono) return NextResponse.json({ error: 'lead sin teléfono' }, { status: 400 })

  // Resolver template_id si vino slug
  let resolvedTemplateId = template_id
  if (!resolvedTemplateId && template_slug) {
    resolvedTemplateId = (await resolveTemplateSlug(template_slug)) || undefined
    if (!resolvedTemplateId) {
      return NextResponse.json({
        error: `template "${template_slug}" no encontrado en Vambe (o no está APPROVED)`,
      }, { status: 404 })
    }
  }

  // Anti-doble (2 min mismo patrón que reactivate-vambe-3d)
  const since = new Date(Date.now() - 120_000).toISOString()
  const { data: recent } = await supabase
    .from('lead_actividad')
    .select('id')
    .eq('lead_id', lead.id)
    .in('tipo', ['bot_template_sent', 'bot_template_started', 'template_send_started', 'template_sent'])
    .gte('created_at', since)
    .limit(1)
  if (recent && recent.length > 0) {
    return NextResponse.json({
      ok: false,
      error: 'template ya enviado hace <2 min (anti doble)',
    }, { status: 409 })
  }

  // Lock
  const { data: lockRow, error: lockErr } = await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'bot_template_started',
    descripcion: `🤖 Asistente Fer: enviando ${template_slug || resolvedTemplateId}…`,
    metadata: { source: 'asistente-fer-bot', template_id: resolvedTemplateId, template_slug },
  }).select('id').single()
  if (lockErr || !lockRow) {
    return NextResponse.json({ ok: false, error: 'no se pudo iniciar el envío' }, { status: 500 })
  }
  const lockId = (lockRow as { id: string }).id

  try {
    const result = await sendTemplate({
      phone: lead.telefono,
      templateId: resolvedTemplateId!,
      stageId: stage_id,
      data,
    })

    // Detectar fail explícito (Vambe a veces devuelve 200 con error en body)
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
        tipo: 'bot_template_failed',
        descripcion: `⚠️ Asistente Fer: Vambe rechazó ${template_slug}: ${reason}`,
        metadata: { source: 'asistente-fer-bot', vambe_response: r, template_id: resolvedTemplateId, template_slug },
      }).eq('id', lockId)
      return NextResponse.json({ ok: false, error: `Vambe rechazó: ${reason}`, vambe_response: r }, { status: 502 })
    }

    await supabase.from('lead_actividad').update({
      tipo: 'bot_template_sent',
      descripcion: `🤖 Asistente Fer: plantilla ${template_slug || 'ID:' + resolvedTemplateId} enviada`,
      metadata: { source: 'asistente-fer-bot', template_id: resolvedTemplateId, template_slug },
    }).eq('id', lockId)

    // Actualizar last-contact + veces_contactado + status si aplica
    const updates: Record<string, unknown> = {
      ultimo_contacto: new Date().toISOString(),
      veces_contactado: (lead.veces_contactado || 0) + 1,
    }
    if (lead.status === 'nuevo') {
      updates.status = 'contactado'
      updates.status_changed_at = new Date().toISOString()
    }
    const { data: updated } = await supabase
      .from('leads').update(updates).eq('id', lead.id).select('*').single()

    return NextResponse.json({ ok: true, template_id: resolvedTemplateId, lead: updated })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    await supabase.from('lead_actividad').update({
      tipo: 'bot_template_failed',
      descripcion: `⚠️ Asistente Fer: excepción ${errMsg}`,
      metadata: { source: 'asistente-fer-bot', error: errMsg, template_id: resolvedTemplateId, template_slug },
    }).eq('id', lockId)
    return NextResponse.json({ ok: false, error: errMsg }, { status: 502 })
  }
}
