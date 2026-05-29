import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import {
  getContactsByDays,
  getMessages,
  parseFormMessage,
  type FormFields,
  type VambeContact,
} from '@/lib/vambe'

export const dynamic = 'force-dynamic'
export const maxDuration = 60   // Vercel free: 60s. Si tenés muchos, ajustar pageSize.

type Supabase = ReturnType<typeof createServiceClient>

/**
 * GET /api/vambe/backfill?days=2&dry=true|false&secret=...
 *
 * Itera los stages en VAMBE_STAGE_MAP, trae contactos de Vambe con
 * actividad en los últimos N días, parsea su formulario inicial, y
 * upsertea en el CRM con el status que corresponde según la stage.
 *
 * - `days`: cuántos días para atrás (default 2 = hoy + ayer).
 * - `dry`: si true, no escribe — solo devuelve el preview.
 * - `secret`: query param obligatorio (= VAMBE_WEBHOOK_SECRET).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!process.env.VAMBE_WEBHOOK_SECRET || secret !== process.env.VAMBE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!process.env.VAMBE_API_KEY) {
    return NextResponse.json({ error: 'VAMBE_API_KEY no configurada' }, { status: 500 })
  }

  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') || '3')))
  const dry = url.searchParams.get('dry') !== 'false'   // default = true por seguridad

  const stageMap = getStageMap()
  if (Object.keys(stageMap).length === 0) {
    return NextResponse.json({ error: 'VAMBE_STAGE_MAP vacío — configurá los UUIDs' }, { status: 500 })
  }

  const supabase = createServiceClient()

  // Traer TODOS los contactos con actividad en N días — sin filtrar por stage en
  // la API porque el filtro de Vambe es por default_stage_id y no captura
  // contactos que viven en active_ticket_v2.current_stage_id.
  const allContacts = await getContactsByDays({ days })

  // Filtrar client-side: stage relevante = current_stage_id del ticket activo
  // (fallback: default_stage_id).
  const relevant = allContacts
    .map(c => ({
      contact: c,
      stage: (c.active_ticket_v2?.current_stage_id || c.default_stage_id || '') as string,
    }))
    .filter(({ stage }) => stage && stageMap[stage])

  const results = {
    days,
    dry,
    total_contacts_fetched: allContacts.length,
    relevant_contacts: relevant.length,
    distribution: {} as Record<string, { count: number; target_status: string }>,
    by_stage: [] as Array<{
      stage_id: string
      target_status: Lead['status']
      contacts_found: number
      created: number
      updated: number
      skipped: number
      errors: Array<{ contact_id: string; reason: string }>
    }>,
    total_created: 0,
    total_updated: 0,
    total_skipped: 0,
    sample_leads: [] as Array<{ id?: string; nombre: string | null; email: string | null; telefono: string | null; status: string; created: boolean }>,
    // Mostrar también las stages "desconocidas" para diagnóstico
    unknown_stages: {} as Record<string, number>,
  }

  // Contar distribución y stages no mapeadas
  for (const c of allContacts) {
    const stage = (c.active_ticket_v2?.current_stage_id || c.default_stage_id || '') as string
    if (!stage) continue
    if (stageMap[stage]) {
      const key = stage
      if (!results.distribution[key]) results.distribution[key] = { count: 0, target_status: stageMap[stage] }
      results.distribution[key].count++
    } else {
      results.unknown_stages[stage] = (results.unknown_stages[stage] || 0) + 1
    }
  }

  // Agrupar relevantes por stage para reportar por bloque
  const byStage: Record<string, Array<{ contact: typeof allContacts[number] }>> = {}
  for (const { contact, stage } of relevant) {
    if (!byStage[stage]) byStage[stage] = []
    byStage[stage].push({ contact })
  }

  for (const [stageId, items] of Object.entries(byStage)) {
    const targetStatus = stageMap[stageId]
    const block = {
      stage_id: stageId,
      target_status: targetStatus,
      contacts_found: items.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [] as Array<{ contact_id: string; reason: string }>,
    }

    for (const { contact: c } of items) {
      try {
        const outcome = await processContact(supabase, c, targetStatus, stageId, dry)
        if (outcome.created) {
          block.created++
          results.total_created++
          if (results.sample_leads.length < 20) {
            results.sample_leads.push({
              id: outcome.lead?.id,
              nombre: outcome.lead?.nombre || null,
              email: outcome.lead?.email || null,
              telefono: outcome.lead?.telefono || null,
              status: targetStatus,
              created: true,
            })
          }
        } else if (outcome.updated) {
          block.updated++
          results.total_updated++
        } else {
          block.skipped++
          results.total_skipped++
        }
        if (outcome.error) {
          block.errors.push({ contact_id: c.id, reason: outcome.error })
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        block.errors.push({ contact_id: c.id, reason: msg })
        block.skipped++
      }
    }

    results.by_stage.push(block)
  }

  return NextResponse.json(results)
}

function getStageMap(): Record<string, Lead['status']> {
  const raw = process.env.VAMBE_STAGE_MAP
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

async function processContact(
  supabase: Supabase,
  contact: VambeContact,
  targetStatus: Lead['status'],
  stageId: string,
  dry: boolean,
): Promise<{ created: boolean; updated: boolean; lead?: Lead; error?: string }> {
  const aiContactId = contact.id
  if (!aiContactId) return { created: false, updated: false, error: 'sin aiContactId' }

  // 1) Intentar parsear el form desde los mensajes
  let form: FormFields | null = null
  try {
    const messages = await getMessages(aiContactId, 50)
    for (const m of messages) {
      const parsed = parseFormMessage(m.message)
      if (parsed) { form = parsed; break }
    }
  } catch {
    // si falla messages, seguimos con datos del contact
  }

  // Construir set de campos a partir del form + contact metadata
  const fields: Record<string, unknown> = {
    canal_adquisicion: 'Vambe',
    vambe_contact_id: aiContactId,
    vambe_stage_id: stageId,
  }
  // Del form si tenemos
  if (form?.nombre) fields.nombre = form.nombre
  if (form?.email) fields.email = form.email
  if (form?.telefono) fields.telefono = form.telefono
  if (form?.vacante) fields.vacante = form.vacante
  if (form?.presupuesto) fields.presupuesto = form.presupuesto
  if (form?.rol) fields.puesto = form.rol
  // Fallback al contact metadata
  if (!fields.nombre && contact.name) fields.nombre = contact.name
  if (!fields.email && contact.email) fields.email = contact.email.toLowerCase()
  if (!fields.telefono && contact.phone) fields.telefono = contact.phone

  const notas: string[] = []
  if (form?.vacantes_por_mes) notas.push(`Vacantes/mes: ${form.vacantes_por_mes}`)
  if (form?.inbox_url) notas.push(`Inbox Vambe: ${form.inbox_url}`)
  if (notas.length) fields.notas = notas.join('\n')

  // 2) Buscar lead existente
  let lead: Lead | null = null
  if (fields.email) {
    const { data } = await supabase.from('leads').select('*').ilike('email', String(fields.email)).maybeSingle()
    if (data) lead = data as Lead
  }
  if (!lead) {
    const { data } = await supabase.from('leads').select('*').eq('vambe_contact_id', aiContactId).maybeSingle()
    if (data) lead = data as Lead
  }
  if (!lead && fields.telefono) {
    const last10 = String(fields.telefono).replace(/\D/g, '').slice(-10)
    const { data } = await supabase.from('leads').select('*').like('telefono', `%${last10}`).maybeSingle()
    if (data) lead = data as Lead
  }

  // 3) Crear o actualizar
  if (lead) {
    const updates: Record<string, unknown> = {}
    // Solo llenar campos vacíos (no pisar info real del CRM)
    for (const [k, v] of Object.entries(fields)) {
      const existing = (lead as unknown as Record<string, unknown>)[k]
      if (v && (existing === null || existing === undefined || existing === '')) {
        updates[k] = v
      }
    }
    // Status: si el lead actual está en un estado "antes" del target, avanzarlo
    if (shouldAdvanceStatus(lead.status, targetStatus)) {
      updates.status = targetStatus
      updates.status_changed_at = new Date().toISOString()
    }
    // vambe_contact_id y stage siempre se actualizan si están vacíos / cambiaron
    if (!lead.vambe_contact_id) updates.vambe_contact_id = aiContactId
    if (lead.vambe_stage_id !== stageId) updates.vambe_stage_id = stageId

    if (Object.keys(updates).length === 0) {
      return { created: false, updated: false }
    }
    if (dry) return { created: false, updated: true, lead: { ...lead, ...updates } as Lead }
    const { data, error } = await supabase.from('leads').update(updates).eq('id', lead.id).select('*').single()
    if (error) return { created: false, updated: false, error: error.message }

    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'vambe_backfill_update',
      descripcion: `🔄 Actualizado por backfill (stage Vambe → ${targetStatus})`,
      metadata: { source: 'backfill', stage_id: stageId, updates },
    })
    return { created: false, updated: true, lead: data as Lead }
  }

  // Crear nuevo lead — necesitamos al menos email
  if (!fields.email) {
    return { created: false, updated: false, error: 'sin email — no se puede crear' }
  }
  const insert: Record<string, unknown> = {
    ...fields,
    status: targetStatus,
    tipo_evento: 'vambe_form',
    monto: 1160,
  }
  for (const k of Object.keys(insert)) {
    if (insert[k] === undefined) delete insert[k]
  }

  if (dry) {
    return { created: true, updated: false, lead: insert as unknown as Lead }
  }

  const { data, error } = await supabase.from('leads').insert(insert).select('*').single()
  if (error) return { created: false, updated: false, error: error.message }

  await supabase.from('lead_actividad').insert({
    lead_id: (data as Lead).id,
    tipo: 'vambe_backfill_created',
    descripcion: `🚀 Lead creado por backfill (stage Vambe → ${targetStatus})`,
    metadata: { source: 'backfill', stage_id: stageId, form: form || null, contact },
  })
  return { created: true, updated: false, lead: data as Lead }
}

/**
 * Decide si conviene avanzar el status del CRM al target del stage de Vambe.
 * No retrocede (un convertido no vuelve a nuevo).
 */
function shouldAdvanceStatus(current: Lead['status'], target: Lead['status']): boolean {
  const order: Lead['status'][] = [
    'nuevo',
    'contactado',
    'llamada_agendada',
    'no_show_llamada',
    'presentacion_enviada',
    'espera_aprobacion',
    'convertido',
    'cliente_recurrente',
  ]
  // 'descartado' es independiente — si target es descartado siempre avanzamos
  if (target === 'descartado') return current !== 'descartado'
  const ci = order.indexOf(current)
  const ti = order.indexOf(target)
  if (ci === -1 || ti === -1) return current !== target
  return ti > ci
}
