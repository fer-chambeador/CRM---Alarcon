import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { parseFormMessage, type VambeWebhookEvent, type FormFields } from '@/lib/vambe'
import { extractCompanyFromEmail, normalizePuesto, normalizeVacante, buildNotasFromForm } from '@/lib/vambeNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/vambe/webhook
 *
 * Recibe eventos de Vambe (message.received, ticket.*, stage.changed, etc.)
 * Procesa los relevantes y actualiza el lead en el CRM.
 *
 * IMPORTANTE: Vambe espera 200 OK rápido. Procesamos en background lo más posible.
 *
 * Configurar la URL en Vambe vía POST /api/webhooks con topics:
 *   ['message.received','message.sent','ticket.created','ticket.closed','stage.changed']
 */
export async function POST(req: NextRequest) {
  // Validación opcional con secret. Vambe no firma headers por default,
  // pero podés agregar un query param compartido cuando registres el webhook.
  const expected = process.env.VAMBE_WEBHOOK_SECRET
  if (expected) {
    const provided = req.headers.get('x-vambe-secret')
      || new URL(req.url).searchParams.get('secret')
    if (provided !== expected) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const event = await req.json().catch(() => null) as VambeWebhookEvent | null
  if (!event) return NextResponse.json({ error: 'invalid payload' }, { status: 400 })

  // Responder rápido — procesar en background no es trivial en serverless,
  // así que lo hacemos sync pero rápido.
  const supabase = createServiceClient()
  const eventType = event.type || event.event || ''

  try {
    await handleEvent(supabase, eventType, event)
  } catch (e) {
    // Log pero devolver 200 para no triggerar retries en loop
    console.error('Vambe webhook error', eventType, e)
  }

  return NextResponse.json({ received: true, type: eventType })
}

type Supabase = ReturnType<typeof createServiceClient>

async function handleEvent(supabase: Supabase, type: string, event: VambeWebhookEvent) {
  const aiContactId = event.aiContactId
  const data = (event.data || {}) as Record<string, unknown>

  switch (type) {
    case 'message.received':
    case 'message.sent':
      return handleMessage(supabase, type, aiContactId, data)
    case 'ticket.created':
    case 'ticket.updated':
      return handleTicket(supabase, type, aiContactId, data)
    case 'ticket.closed':
      return handleTicketClosed(supabase, aiContactId, data)
    case 'stage.changed':
      return handleStageChanged(supabase, aiContactId, data)
    case 'contact.created':
    case 'contact.updated':
      return  // no-op por ahora — el CRM es source of truth para contactos
    default:
      // unknown event — log y skip
      return
  }
}

/** Encuentra el lead del CRM por aiContactId o, fallback, por phone/email. */
async function findLead(supabase: Supabase, aiContactId: string | undefined, data: Record<string, unknown>): Promise<Lead | null> {
  if (aiContactId) {
    const { data: byId } = await supabase.from('leads').select('*').eq('vambe_contact_id', aiContactId).maybeSingle()
    if (byId) return byId as Lead
  }
  const fromNumber = (data.fromNumber || data.from_number || '') as string
  const toNumber = (data.toNumber || data.to_number || '') as string
  // El número del lead es el que NO sea nuestro channel
  const channelPhone = (process.env.VAMBE_CHANNEL_PHONE || '').replace(/[+\s\-()]/g, '')
  const candidatePhones = [fromNumber, toNumber]
    .map(p => p.replace(/[+\s\-()]/g, ''))
    .filter(p => p && p !== channelPhone)
  for (const phone of candidatePhones) {
    // Match parcial — el sheet/CRM puede no tener prefijo +52
    const last10 = phone.slice(-10)
    const { data: byPhone } = await supabase.from('leads').select('*').like('telefono', `%${last10}`).maybeSingle()
    if (byPhone) return byPhone as Lead
  }
  return null
}

async function handleMessage(supabase: Supabase, type: string, aiContactId: string | undefined, data: Record<string, unknown>) {
  const isInbound = type === 'message.received'
  // Vambe puede mandar el texto en `body` o `message` (y a veces anidado). Probar varios.
  const text = ((data.message || data.body || data.text || data.content
    || (data.payload as Record<string, unknown> | undefined)?.body
    || (data.payload as Record<string, unknown> | undefined)?.text
    || '') as string)

  // CASO ESPECIAL: mensaje con el patrón del formulario. NO creamos el lead
  // todavía — solo guardamos los datos en vambe_pending_leads. La creación
  // se hace cuando el stage avanza a "Interesado" (handleStageChanged).
  if (isInbound) {
    const form = parseFormMessage(text)
    if (form && aiContactId) {
      await stashPendingForm(supabase, aiContactId, form, data)
      return
    }
  }

  // Caso normal: registrar el mensaje en el timeline del lead existente
  const lead = await findLead(supabase, aiContactId, data)
  if (!lead) return

  if (aiContactId && !lead.vambe_contact_id) {
    await supabase.from('leads').update({ vambe_contact_id: aiContactId }).eq('id', lead.id)
  }

  const desc = isInbound
    ? `📥 Cliente: ${text.slice(0, 200)}`
    : `📤 Vambe: ${text.slice(0, 200)}`

  await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'vambe_message',
    descripcion: desc,
    metadata: { source: 'vambe', type, ...data },
  })

  // Si era 'nuevo' y vino mensaje del cliente → 'contactado'
  if (isInbound && lead.status === 'nuevo') {
    await supabase.from('leads').update({
      status: 'contactado',
      status_changed_at: new Date().toISOString(),
      ultimo_contacto: new Date().toISOString(),
      veces_contactado: (lead.veces_contactado || 0) + 1,
    }).eq('id', lead.id)
  }
}

/**
 * Guarda los datos del formulario en vambe_pending_leads sin crear lead todavía.
 * El lead se materializa en `leads` cuando la stage avanza a "Interesado".
 */
async function stashPendingForm(
  supabase: Supabase,
  aiContactId: string,
  form: FormFields,
  rawData: Record<string, unknown>,
): Promise<void> {
  await supabase.from('vambe_pending_leads').upsert({
    vambe_contact_id: aiContactId,
    form_data: form,
    raw_event: rawData,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'vambe_contact_id' })
}

/**
 * Promueve un formulario pendiente a un lead real en el CRM.
 * Se dispara cuando la stage de Vambe avanza a "Interesado".
 * Si ya existe un lead con el mismo email/teléfono/vambe_contact_id,
 * solo actualiza campos vacíos para no pisar info real.
 */
async function promotePendingLead(
  supabase: Supabase,
  aiContactId: string,
): Promise<{ lead: Lead | null; created: boolean; form: FormFields | null }> {
  // 1) Buscar pending
  const { data: pending } = await supabase
    .from('vambe_pending_leads')
    .select('form_data, raw_event')
    .eq('vambe_contact_id', aiContactId)
    .maybeSingle()

  const form = (pending?.form_data || null) as FormFields | null
  if (!form) return { lead: null, created: false, form: null }

  // 2) Buscar lead existente (email > vambe_contact_id > teléfono)
  let lead: Lead | null = null
  if (form.email) {
    const { data } = await supabase.from('leads').select('*').ilike('email', form.email).maybeSingle()
    if (data) lead = data as Lead
  }
  if (!lead) {
    const { data } = await supabase.from('leads').select('*').eq('vambe_contact_id', aiContactId).maybeSingle()
    if (data) lead = data as Lead
  }
  if (!lead && form.telefono) {
    const last10 = form.telefono.replace(/\D/g, '').slice(-10)
    const { data } = await supabase.from('leads').select('*').like('telefono', `%${last10}`).maybeSingle()
    if (data) lead = data as Lead
  }

  // 3) Construir campos — aplicar normalizaciones a vacante y puesto
  const fields: Record<string, unknown> = {
    canal_adquisicion: 'Vambe',
    vambe_contact_id: aiContactId,
  }
  if (form.nombre) fields.nombre = form.nombre
  if (form.email) fields.email = form.email
  if (form.telefono) fields.telefono = form.telefono
  if (form.vacante) fields.vacante = normalizeVacante(form.vacante)
  if (form.presupuesto) fields.presupuesto = form.presupuesto
  if (form.rol) fields.puesto = normalizePuesto(form.rol)
  const company = extractCompanyFromEmail(form.email)
  if (company) fields.empresa = company
  const notas = buildNotasFromForm(form)
  if (notas) fields.notas = notas

  // Campos que SIEMPRE se sobreescriben para mantener data limpia
  const NORMALIZED_FIELDS = new Set(['vacante', 'puesto', 'notas'])

  let resultLead: Lead | null = lead
  let created = false

  if (lead) {
    const updates: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) {
      const existing = (lead as unknown as Record<string, unknown>)[k]
      if (NORMALIZED_FIELDS.has(k) && v) {
        // Re-normalizar siempre
        if (v !== existing) updates[k] = v
      } else if (v && (existing === null || existing === undefined || existing === '')) {
        updates[k] = v
      }
    }
    if (!lead.vambe_contact_id) updates.vambe_contact_id = aiContactId
    if (!lead.canal_adquisicion) updates.canal_adquisicion = 'Vambe'
    if (Object.keys(updates).length > 0) {
      await supabase.from('leads').update(updates).eq('id', lead.id)
      resultLead = { ...lead, ...updates } as Lead
    }
  } else if (form.email) {
    // Crear nuevo lead — el form tiene que tener al menos email
    const insert: Record<string, unknown> = {
      ...fields,
      email: form.email,
      status: 'nuevo',
      tipo_evento: 'vambe_form',
      monto: 1160,
    }
    for (const k of Object.keys(insert)) {
      if (insert[k] === undefined) delete insert[k]
    }
    const { data, error } = await supabase.from('leads').insert(insert).select('*').single()
    if (error) {
      console.error('Vambe promotePendingLead insert error', error.message)
      return { lead: null, created: false, form }
    }
    resultLead = data as Lead
    created = true
  } else {
    // No hay email — no podemos crear
    return { lead: null, created: false, form }
  }

  // 4) Limpiar el pending
  await supabase.from('vambe_pending_leads').delete().eq('vambe_contact_id', aiContactId)

  return { lead: resultLead, created, form }
}

async function handleTicket(supabase: Supabase, type: string, aiContactId: string | undefined, data: Record<string, unknown>) {
  const lead = await findLead(supabase, aiContactId, data)
  if (!lead) return

  await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: type,
    descripcion: type === 'ticket.created' ? '🎫 Ticket abierto en Vambe' : '🎫 Ticket actualizado en Vambe',
    metadata: { source: 'vambe', type, ...data },
  })

  if (type === 'ticket.created' && lead.status === 'nuevo') {
    await supabase.from('leads').update({
      status: 'contactado',
      status_changed_at: new Date().toISOString(),
    }).eq('id', lead.id)
  }
}

async function handleTicketClosed(supabase: Supabase, aiContactId: string | undefined, data: Record<string, unknown>) {
  const lead = await findLead(supabase, aiContactId, data)
  if (!lead) return

  // Vambe puede indicar el outcome — 'won' / 'lost' / 'closed'
  const outcome = String(data.outcome || data.result || data.status || '').toLowerCase()
  let newStatus: Lead['status'] | null = null
  if (outcome.includes('won') || outcome.includes('convert')) newStatus = 'convertido'
  else if (outcome.includes('lost') || outcome.includes('descart')) newStatus = 'descartado'

  await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'ticket.closed',
    descripcion: `🎫 Ticket cerrado en Vambe${outcome ? ` (${outcome})` : ''}`,
    metadata: { source: 'vambe', ...data },
  })

  if (newStatus && newStatus !== lead.status) {
    await supabase.from('leads').update({
      status: newStatus,
      status_changed_at: new Date().toISOString(),
    }).eq('id', lead.id)
  }
}

/**
 * Mapeo de stages de Vambe → status del CRM.
 * Configurable via env var VAMBE_STAGE_MAP en formato JSON:
 *   '{"stage-uuid-1":"contactado","stage-uuid-2":"presentacion_enviada"}'
 */
function getStageMap(): Record<string, Lead['status']> {
  const raw = process.env.VAMBE_STAGE_MAP
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

/** Busca cualquier campo en `data` que parezca fecha de llamada y lo devuelve como ISO string. */
function extractLlamadaAt(data: Record<string, unknown>): string | null {
  const candidates = [
    'llamada_at', 'llamadaAt',
    'appointment_at', 'appointmentAt',
    'scheduled_at', 'scheduledAt',
    'meeting_at', 'meetingAt',
    'booking_at', 'bookingAt',
    'fecha', 'fecha_hora', 'fechaHora',
    'start', 'start_time', 'startTime',
    'date', 'datetime',
  ]
  for (const key of candidates) {
    const v = data[key]
    if (typeof v === 'string' && v.trim()) {
      const d = new Date(v)
      if (!isNaN(d.getTime())) return d.toISOString()
    } else if (typeof v === 'number' && v > 0) {
      // Posible epoch (segundos o ms)
      const ms = v < 1e12 ? v * 1000 : v
      const d = new Date(ms)
      if (!isNaN(d.getTime())) return d.toISOString()
    }
  }
  return null
}

async function handleStageChanged(supabase: Supabase, aiContactId: string | undefined, data: Record<string, unknown>) {
  const newStageId = (data.new_stage_id || data.newStageId || data.stageId || '') as string
  const previousStageId = (data.previous_stage_id || data.previousStageId || '') as string

  const map = getStageMap()
  const mappedStatus = map[newStageId]

  // CASO ESPECIAL: stage avanza a "Interesado" (mappedStatus === 'nuevo').
  // Si el lead aún no existe en el CRM, lo creamos a partir del pending form.
  let lead = await findLead(supabase, aiContactId, data)
  let promoted = false

  if (!lead && mappedStatus === 'nuevo' && aiContactId) {
    const promotion = await promotePendingLead(supabase, aiContactId)
    if (promotion.lead) {
      lead = promotion.lead
      promoted = promotion.created
      if (promotion.created) {
        await supabase.from('lead_actividad').insert({
          lead_id: lead.id,
          tipo: 'vambe_lead_promoted',
          descripcion: '🚀 Lead promovido al CRM al pasar a "Interesado" en Vambe',
          metadata: { source: 'vambe', stage_id: newStageId, form: promotion.form },
        })
      }
    } else {
      // Stage a Interesado pero no hay pending form — log y skip
      console.warn(`Vambe stage→Interesado sin pending form. aiContactId=${aiContactId}`)
    }
  }

  if (!lead) return

  const updates: Record<string, unknown> = { vambe_stage_id: newStageId }
  if (mappedStatus && mappedStatus !== lead.status) {
    updates.status = mappedStatus
    updates.status_changed_at = new Date().toISOString()
  }

  // Si la nueva stage corresponde a "llamada agendada", intentar extraer fecha/hora
  let llamadaAtSaved: string | null = null
  if (mappedStatus === 'llamada_agendada') {
    const llamadaAt = extractLlamadaAt(data)
    if (llamadaAt) {
      updates.llamada_at = llamadaAt
      llamadaAtSaved = llamadaAt
    }
  }

  await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'vambe_stage_change',
    descripcion: `Pipeline Vambe: ${previousStageId || '?'} → ${newStageId}${mappedStatus ? ` (CRM status → ${mappedStatus})` : ''}${llamadaAtSaved ? ` 📅 ${llamadaAtSaved}` : ''}${promoted ? ' · nuevo lead' : ''}`,
    metadata: { source: 'vambe', llamada_at: llamadaAtSaved, promoted, ...data },
  })

  await supabase.from('leads').update(updates).eq('id', lead.id)
}
