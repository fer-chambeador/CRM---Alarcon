import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { sendTemplateBulk } from '@/lib/vambe'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type SegmentFilter = {
  status?: Lead['status'][]
  canal_adquisicion?: string[]
  vacante?: string
  presupuesto?: Lead['presupuesto'][]
  diasSinContactarMin?: number
  diasSinContactarMax?: number
}

/**
 * POST /api/templates/send
 *
 * Body:
 *   {
 *     templateId: string
 *     leadIds?: string[]              // envío a leads específicos
 *     segment?: SegmentFilter         // envío por segmento
 *     overrideVars?: Record<string,string>  // opcional, manda mismos vars a todos
 *     dryRun?: boolean                // si true → solo cuenta leads, no envía
 *     stageId?: string                // opcional, stage de Vambe a aplicar
 *   }
 */
export async function POST(req: NextRequest) {
  if (!process.env.VAMBE_API_KEY) {
    return NextResponse.json({ error: 'VAMBE_API_KEY no configurada' }, { status: 500 })
  }
  if (!process.env.VAMBE_CHANNEL_PHONE) {
    return NextResponse.json({ error: 'VAMBE_CHANNEL_PHONE no configurada' }, { status: 500 })
  }

  let body: {
    templateId?: string
    leadIds?: string[]
    segment?: SegmentFilter
    overrideVars?: Record<string, string>
    dryRun?: boolean
    stageId?: string
  } = {}
  try { body = await req.json() } catch { /* ignore */ }

  if (!body.templateId) {
    return NextResponse.json({ error: 'templateId requerido' }, { status: 400 })
  }
  if (!body.leadIds && !body.segment) {
    return NextResponse.json({ error: 'Necesitas leadIds o segment' }, { status: 400 })
  }
  const templateId = body.templateId

  const supabase = createServiceClient()

  // 1) Resolver lista de leads
  let leads: Lead[] = []
  if (body.leadIds && body.leadIds.length) {
    const { data, error } = await supabase.from('leads').select('*').in('id', body.leadIds)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    leads = (data || []) as Lead[]
  } else if (body.segment) {
    let q = supabase.from('leads').select('*')
    if (body.segment.status?.length) q = q.in('status', body.segment.status)
    if (body.segment.canal_adquisicion?.length) q = q.in('canal_adquisicion', body.segment.canal_adquisicion)
    if (body.segment.vacante) q = q.ilike('vacante', `%${body.segment.vacante}%`)
    if (body.segment.presupuesto?.length) q = q.in('presupuesto', body.segment.presupuesto)
    const { data, error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    leads = (data || []) as Lead[]

    // Filtro client-side por días sin contactar
    if (typeof body.segment.diasSinContactarMin === 'number' || typeof body.segment.diasSinContactarMax === 'number') {
      const now = Date.now()
      leads = leads.filter(l => {
        const ref = l.ultimo_contacto || l.status_changed_at || l.created_at
        if (!ref) return false
        const days = (now - new Date(ref).getTime()) / 86400000
        if (typeof body.segment?.diasSinContactarMin === 'number' && days < body.segment.diasSinContactarMin) return false
        if (typeof body.segment?.diasSinContactarMax === 'number' && days > body.segment.diasSinContactarMax) return false
        return true
      })
    }
  }

  // 2) Filtrar leads sin teléfono (no se les puede mandar template de WhatsApp)
  const sendable = leads.filter(l => !!l.telefono)
  const skipped = leads.length - sendable.length

  if (body.dryRun) {
    return NextResponse.json({
      preview: true,
      total: leads.length,
      sendable: sendable.length,
      skipped,
      leads: sendable.map(l => ({ id: l.id, email: l.email, nombre: l.nombre, telefono: l.telefono })),
    })
  }

  if (sendable.length === 0) {
    return NextResponse.json({ error: 'No hay leads con teléfono para enviar' }, { status: 400 })
  }

  // 3) Armar items para el bulk send
  const items = sendable.map(l => {
    const item: Record<string, unknown> = {
      phone_number: l.telefono!,
      // Variables comunes que el AI de Vambe puede mapear
      nombre: l.nombre || 'amigo',
      empresa: l.empresa || '',
      vacante: l.vacante || '',
      email: l.email || '',
      puesto: l.puesto || '',
    }
    if (body.overrideVars) Object.assign(item, body.overrideVars)
    return item
  })

  // 4) Disparar bulk send
  try {
    const result = await sendTemplateBulk({
      templateId,
      items,
      stageId: body.stageId,
    })

    // 5) Registrar actividad en cada lead
    const activityRows = sendable.map(l => ({
      lead_id: l.id,
      tipo: 'vambe_template_sent',
      descripcion: `📨 Template enviado vía Vambe (${templateId.slice(0, 8)}…)`,
      metadata: { source: 'crm', template_id: templateId, segment: body.segment, override_vars: body.overrideVars },
    }))
    if (activityRows.length) {
      await supabase.from('lead_actividad').insert(activityRows)
    }

    return NextResponse.json({
      ok: true,
      sent: sendable.length,
      skipped,
      total: leads.length,
      result,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
