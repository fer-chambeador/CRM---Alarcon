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
 * Recipient externo (de Excel): contiene phone obligatorio + vars opcionales.
 * Si no se puede matchear con un lead, igual se manda (lead_id=null en campaign).
 */
type ExternalRecipient = {
  phone_number: string
  email?: string
  nombre?: string
  empresa?: string
  vacante?: string
  // resto de campos se mandan como vars del template
  [k: string]: unknown
}

/**
 * POST /api/templates/send
 *
 * Modos:
 *   - segment: filtra leads del CRM por criterios
 *   - leadIds: lista explícita de lead IDs
 *   - externalRecipients: lista de phone+vars (típicamente desde Excel)
 *
 * Body:
 *   {
 *     templateId: string
 *     templateName?: string          // se guarda en campaign para historial
 *     templateBody?: string
 *     leadIds?: string[]
 *     segment?: SegmentFilter
 *     externalRecipients?: ExternalRecipient[]
 *     overrideVars?: Record<string,string>   // vars globales (se mandan a todos)
 *     dryRun?: boolean
 *     stageId?: string
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
    templateName?: string
    templateBody?: string
    leadIds?: string[]
    segment?: SegmentFilter
    externalRecipients?: ExternalRecipient[]
    overrideVars?: Record<string, string>
    dryRun?: boolean
    stageId?: string
  } = {}
  try { body = await req.json() } catch { /* ignore */ }

  if (!body.templateId) {
    return NextResponse.json({ error: 'templateId requerido' }, { status: 400 })
  }
  if (!body.leadIds && !body.segment && !body.externalRecipients) {
    return NextResponse.json({ error: 'Necesitas leadIds, segment o externalRecipients' }, { status: 400 })
  }
  const templateId = body.templateId

  const supabase = createServiceClient()

  // ── 1) Resolver lista de destinatarios y leads correspondientes ──
  let leads: Lead[] = []
  let externalRows: ExternalRecipient[] = []
  let source: 'segment' | 'manual' | 'excel' = 'segment'

  if (body.externalRecipients && body.externalRecipients.length) {
    source = 'excel'
    externalRows = body.externalRecipients.filter(r => r.phone_number)
    // Para cada external recipient, intentar matchear con un lead existente por email o teléfono
    const emails = externalRows.map(r => r.email?.toLowerCase().trim()).filter(Boolean) as string[]
    const phones = externalRows.map(r => r.phone_number).filter(Boolean) as string[]
    const last10 = phones.map(p => p.replace(/\D/g, '').slice(-10)).filter(Boolean)

    const { data: byEmail } = emails.length
      ? await supabase.from('leads').select('*').in('email', emails)
      : { data: [] as Lead[] }
    const matchedByEmail = new Map<string, Lead>()
    for (const l of (byEmail || []) as Lead[]) {
      if (l.email) matchedByEmail.set(l.email.toLowerCase(), l)
    }

    leads = (byEmail || []) as Lead[]
    // Sumar leads matcheados por teléfono que aún no estén
    for (const last of last10) {
      if (!last) continue
      const { data: byPhone } = await supabase.from('leads').select('*').like('telefono', `%${last}`).limit(1)
      if (byPhone && byPhone[0] && !leads.find(l => l.id === (byPhone[0] as Lead).id)) {
        leads.push(byPhone[0] as Lead)
      }
    }
  } else if (body.leadIds && body.leadIds.length) {
    source = 'manual'
    const { data, error } = await supabase.from('leads').select('*').in('id', body.leadIds)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    leads = (data || []) as Lead[]
  } else if (body.segment) {
    source = 'segment'
    let q = supabase.from('leads').select('*')
    if (body.segment.status?.length) q = q.in('status', body.segment.status)
    if (body.segment.canal_adquisicion?.length) q = q.in('canal_adquisicion', body.segment.canal_adquisicion)
    if (body.segment.vacante) q = q.ilike('vacante', `%${body.segment.vacante}%`)
    if (body.segment.presupuesto?.length) q = q.in('presupuesto', body.segment.presupuesto)
    const { data, error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    leads = (data || []) as Lead[]
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

  // ── 2) Armar destinatarios efectivos (con phone) y mapearlos a su lead si existe ──
  type Recipient = {
    phone: string
    lead?: Lead
    extraVars?: Record<string, unknown>     // vars de Excel para ESTE recipient
    email?: string
    nombre?: string
  }
  const recipients: Recipient[] = []

  if (source === 'excel') {
    for (const row of externalRows) {
      const phoneNormalized = String(row.phone_number).replace(/\s|-|\(|\)/g, '')
      // Buscar lead match
      const last10 = phoneNormalized.replace(/\D/g, '').slice(-10)
      const matchByEmail = row.email ? leads.find(l => l.email?.toLowerCase() === row.email?.toLowerCase().trim()) : undefined
      const matchByPhone = last10 ? leads.find(l => (l.telefono || '').replace(/\D/g, '').slice(-10) === last10) : undefined
      const lead = matchByEmail || matchByPhone

      const { phone_number, email, nombre, empresa, vacante, ...rest } = row
      recipients.push({
        phone: phoneNormalized,
        lead,
        extraVars: { nombre, empresa, vacante, ...rest },
        email,
        nombre,
      })
    }
  } else {
    for (const l of leads) {
      if (!l.telefono) continue
      recipients.push({ phone: l.telefono, lead: l, email: l.email, nombre: l.nombre || undefined })
    }
  }

  const sendable = recipients.filter(r => !!r.phone)
  const skipped = (source === 'excel' ? externalRows.length : leads.length) - sendable.length

  if (body.dryRun) {
    return NextResponse.json({
      preview: true,
      source,
      total: source === 'excel' ? externalRows.length : leads.length,
      sendable: sendable.length,
      skipped,
      matched_leads: recipients.filter(r => r.lead).length,
      recipients: sendable.slice(0, 50).map(r => ({
        phone: r.phone,
        email: r.email || r.lead?.email,
        nombre: r.nombre || r.lead?.nombre,
        matched_lead_id: r.lead?.id || null,
      })),
    })
  }

  if (sendable.length === 0) {
    return NextResponse.json({ error: 'No hay destinatarios con teléfono para enviar' }, { status: 400 })
  }

  // ── 3) Armar items para el bulk send de Vambe ──
  const items = sendable.map(r => {
    const item: Record<string, unknown> = {
      phone_number: r.phone,
      nombre: r.nombre || r.lead?.nombre || 'amigo',
      empresa: (r.extraVars?.empresa as string) || r.lead?.empresa || '',
      vacante: (r.extraVars?.vacante as string) || r.lead?.vacante || '',
      email: r.email || r.lead?.email || '',
      puesto: r.lead?.puesto || '',
    }
    // Merge extraVars del Excel
    if (r.extraVars) {
      for (const [k, v] of Object.entries(r.extraVars)) {
        if (v != null && v !== '') item[k] = v
      }
    }
    // Override vars globales
    if (body.overrideVars) Object.assign(item, body.overrideVars)
    return item
  })

  // ── 4) Crear la campaña en DB ANTES de mandar (para poder linkear actividad) ──
  // Si las tablas no existen aún (migration no corrida), seguimos sin tracking.
  let campaignId: string | null = null
  try {
    const { data: campaign, error: cErr } = await supabase.from('vambe_campaigns').insert({
      template_id: templateId,
      template_name: body.templateName || null,
      template_body: body.templateBody || null,
      segment: body.segment || null,
      override_vars: body.overrideVars || null,
      total_targeted: sendable.length,
      total_sent: 0,
      total_failed: 0,
      source,
    }).select('id').maybeSingle()
    if (!cErr) campaignId = (campaign as { id?: string } | null)?.id || null
    else console.warn('vambe_campaigns insert error (tabla probablemente no migrada):', cErr.message)
  } catch (e) {
    console.warn('vambe_campaigns insert exception:', e)
  }

  // ── 5) Insertar recipients en DB con sent_at provisional null ──
  if (campaignId) {
    const recipientRows = sendable.map(r => ({
      campaign_id: campaignId,
      lead_id: r.lead?.id || null,
      phone: r.phone,
      email: r.email || r.lead?.email || null,
      nombre: r.nombre || r.lead?.nombre || null,
      vars: r.extraVars || null,
    }))
    if (recipientRows.length) {
      try {
        await supabase.from('vambe_campaign_recipients').insert(recipientRows)
      } catch (e) {
        console.warn('vambe_campaign_recipients insert exception:', e)
      }
    }
  }

  // ── 6) Disparar bulk send a Vambe ──
  let sendError: string | null = null
  let sendResult: unknown = null
  try {
    sendResult = await sendTemplateBulk({ templateId, items, stageId: body.stageId })
  } catch (e) {
    sendError = e instanceof Error ? e.message : String(e)
  }

  const sentAt = new Date().toISOString()

  // ── 7) Marcar recipients como enviados (o con error) ──
  if (campaignId) {
    try {
      if (sendError) {
        await supabase
          .from('vambe_campaign_recipients')
          .update({ send_error: sendError })
          .eq('campaign_id', campaignId)
        await supabase.from('vambe_campaigns').update({ total_failed: sendable.length }).eq('id', campaignId)
      } else {
        await supabase
          .from('vambe_campaign_recipients')
          .update({ sent_at: sentAt })
          .eq('campaign_id', campaignId)
        await supabase.from('vambe_campaigns').update({ total_sent: sendable.length }).eq('id', campaignId)
      }
    } catch (e) {
      console.warn('campaign tracking update exception:', e)
    }
  }

  // ── 8) Registrar actividad en cada lead matcheado + auto-status (nuevo → contactado) ──
  if (!sendError) {
    const matchedLeads = sendable.map(r => r.lead).filter(Boolean) as Lead[]
    if (matchedLeads.length) {
      const activityRows = matchedLeads.map(l => ({
        lead_id: l.id,
        tipo: 'vambe_template_sent',
        descripcion: `📨 Template enviado vía Vambe (${(body.templateName || templateId).slice(0, 30)})`,
        metadata: {
          source: 'crm',
          template_id: templateId,
          template_name: body.templateName,
          campaign_id: campaignId,
          override_vars: body.overrideVars,
        },
      }))
      await supabase.from('lead_actividad').insert(activityRows)

      // Auto-status: leads en 'nuevo' → 'contactado' (la AI o vendedor les habló)
      const nuevoIds = matchedLeads.filter(l => l.status === 'nuevo').map(l => l.id)
      if (nuevoIds.length) {
        await supabase.from('leads').update({
          status: 'contactado',
          status_changed_at: sentAt,
          ultimo_contacto: sentAt,
        }).in('id', nuevoIds)
      }
      // Para los que ya estaban contactados o más adelante: solo bump ultimo_contacto + veces_contactado
      const otherIds = matchedLeads.filter(l => l.status !== 'nuevo' && l.status !== 'convertido' && l.status !== 'cliente_recurrente' && l.status !== 'descartado').map(l => l.id)
      if (otherIds.length) {
        for (const id of otherIds) {
          const lead = matchedLeads.find(x => x.id === id)
          if (!lead) continue
          await supabase.from('leads').update({
            ultimo_contacto: sentAt,
            veces_contactado: (lead.veces_contactado || 0) + 1,
          }).eq('id', id)
        }
      }
    }
  }

  if (sendError) {
    return NextResponse.json({
      ok: false,
      error: sendError,
      campaign_id: campaignId,
      targeted: sendable.length,
    }, { status: 502 })
  }

  return NextResponse.json({
    ok: true,
    sent: sendable.length,
    skipped,
    total: source === 'excel' ? externalRows.length : leads.length,
    campaign_id: campaignId,
    matched_leads: sendable.filter(r => r.lead).length,
    result: sendResult,
  })
}
