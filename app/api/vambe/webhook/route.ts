import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { parseFormMessage, getMessages, type VambeWebhookEvent, type FormFields } from '@/lib/vambe'
import { extractCompanyFromEmail, normalizePuesto, normalizeVacante, buildNotasFromForm } from '@/lib/vambeNormalize'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'
import { alertAtencionHumana, alertVentaCerrada, alertHighValueLead } from '@/lib/slackAlert'
import { alertAtencionHumanaVambe, alertNuevoMensajeVambe } from '@/lib/slackAlertVambe'

// Stage UUIDs especiales para disparar alertas y triggers de negocio.
// Si Vambe cambia los UUIDs, actualizar acá (o moverlo a env vars).
const STAGE_ATENCION_HUMANA   = 'dd41a38e-3b22-42f3-a6d3-b130b9ca449f'
const STAGE_GANADOS           = 'c86a7911-ef9d-4f6d-8c90-3e9a9a4d6b50'
const STAGE_PERDIDOS          = '9a43e657-b5cc-4baf-a503-1e0b37b9b366'

// Stages que corresponden a tipos específicos de llamada:
const STAGE_DEMO_AGENDADA     = '971fe009-72d1-44fb-932b-aa94adcec4db'  // Agendados Consultoría 📆
const STAGE_DEMO_CONFIRMADA   = '2fc44415-960f-4dbd-b65b-1500636fc41a'  // Confirmados ✅
const STAGE_LLAMADA_COMERCIAL = 'cd0ab574-c844-4346-bea3-4ddd084fcb92'  // Llamadas ☎️

// Stage extra usado para alertas de "nuevo mensaje":
const STAGE_CONTACTADOS_WA    = '5847352c-f983-4e8b-b635-b19797d031a8'  // Contactados via WhatsApp

// Mapa stage_id → label + key para alertas de nuevo mensaje en Slack.
// Solo los stages aquí listados disparan alerta de "nuevo mensaje" en inbound.
const NUEVO_MENSAJE_STAGES: Record<string, { key: 'asistencia_humana' | 'confirmados' | 'llamadas' | 'contactados_whatsapp' | 'ganados'; label: string }> = {
  [STAGE_ATENCION_HUMANA]:   { key: 'asistencia_humana',     label: 'Asistencia humana' },
  [STAGE_DEMO_CONFIRMADA]:   { key: 'confirmados',           label: 'Confirmados ✅' },
  [STAGE_LLAMADA_COMERCIAL]: { key: 'llamadas',              label: 'Llamadas ☎️' },
  [STAGE_CONTACTADOS_WA]:    { key: 'contactados_whatsapp',  label: 'Contactados via WhatsApp' },
  [STAGE_GANADOS]:           { key: 'ganados',               label: 'Ganados 🏆' },
}

function tipoLlamadaForStage(stageId: string): 'demo' | 'comercial' | null {
  if (stageId === STAGE_DEMO_AGENDADA || stageId === STAGE_DEMO_CONFIRMADA) return 'demo'
  if (stageId === STAGE_LLAMADA_COMERCIAL) return 'comercial'
  return null
}

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

  const rawEvent = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!rawEvent) return NextResponse.json({ error: 'invalid payload' }, { status: 400 })

  // Vambe usa DOS formatos según el tipo de evento:
  //   Formato A (mensajes): { type, aiContactId, data: {...} }
  //   Formato B (stage/ticket): { topic, event_type, entity_name, entity_data: {...}, previous_entity_data }
  // Normalizamos ambos a un shape único para el handler.
  const entityData = (rawEvent.entity_data || rawEvent.entityData || null) as Record<string, unknown> | null
  const eventType = String(
    rawEvent.type
    || rawEvent.event
    || rawEvent.topic                          // formato B
    || (entityData && rawEvent.event_type ? `${rawEvent.event_type}.${rawEvent.entity_name || 'unknown'}` : rawEvent.event_type)
    || ''
  )
  const aiContactId = String(
    rawEvent.aiContactId
    || rawEvent.ai_contact_id
    || entityData?.ai_contact_id
    || entityData?.aiContactId
    || ''
  ) || undefined

  // Para handlers que esperan `data`, mergeamos data + entity_data en un solo objeto
  const data = {
    ...(rawEvent.data as Record<string, unknown> || {}),
    ...(entityData || {}),
    previous_entity_data: rawEvent.previous_entity_data,
  } as Record<string, unknown>

  const event: VambeWebhookEvent = {
    type: eventType,
    aiContactId,
    data,
    ...rawEvent,
  }

  const supabase = createServiceClient()

  // PRIMERO: log de cada evento entrante (para diagnóstico).
  try {
    await supabase.from('vambe_webhook_log').insert({
      event_type: eventType || '(empty)',
      ai_contact_id: aiContactId || null,
      payload: rawEvent,
    })
  } catch { /* tabla no migró aún — ignore */ }

  // Después: dispatch normal
  try {
    await handleEvent(supabase, eventType, event)
  } catch (e) {
    console.error('Vambe webhook error', eventType, e)
  }

  return NextResponse.json({ received: true, type: eventType })
}

type Supabase = ReturnType<typeof createServiceClient>

async function handleEvent(supabase: Supabase, type: string, event: VambeWebhookEvent) {
  const aiContactId = event.aiContactId
  const data = (event.data || {}) as Record<string, unknown>

  // Normalizar el tipo de evento — Vambe usa varios formatos según versión:
  //   'stage.changed' | 'contact.stage.changed' | 'stage_change' | 'contact.stage_changed'
  //   'message.received' | 'contact.message.received' | 'message_received'
  const norm = type.toLowerCase().replace(/[._]/g, '.')

  // Mensajes (inbound/outbound)
  if (norm.includes('message.received') || norm === 'message.received') {
    return handleMessage(supabase, 'message.received', aiContactId, data)
  }
  if (norm.includes('message.sent') || norm === 'message.sent') {
    return handleMessage(supabase, 'message.sent', aiContactId, data)
  }

  // Cambio de stage en pipeline — la versión más común sería 'stage.changed' pero
  // Vambe también usa 'contact.stage.changed' o 'contact.stage_changed' (de ahí el
  // label en español "Cambio de etapa del contacto").
  if (norm.includes('stage.changed') || norm.includes('stage.change')
      || norm === 'pipeline.stage.changed' || norm.includes('etapa')) {
    return handleStageChanged(supabase, aiContactId, data)
  }

  // Tickets
  if (norm.includes('ticket.created') || norm === 'ticket.opened') {
    return handleTicket(supabase, 'ticket.created', aiContactId, data)
  }
  if (norm.includes('ticket.updated')) {
    return handleTicket(supabase, 'ticket.updated', aiContactId, data)
  }
  if (norm.includes('ticket.closed')) {
    return handleTicketClosed(supabase, aiContactId, data)
  }

  // Contacts — no-op por ahora
  if (norm.includes('contact.created') || norm.includes('contact.updated')
      || norm === 'contact.metadata.updated') {
    return
  }

  // Unknown event — loguear en una fila de actividad para diagnóstico futuro,
  // pero sin lead (porque no sabemos a quién corresponde). Logueamos sin lead_id
  // si no hay match, así nos enteramos qué nombre real usa Vambe.
  console.warn('Vambe webhook UNKNOWN event type:', type, '| normalized:', norm, '| sample data keys:', Object.keys(data))

  // Si el evento tiene aiContactId, intentamos asociar el log a un lead
  if (aiContactId) {
    const lead = await findLead(supabase, aiContactId, data)
    if (lead) {
      await supabase.from('lead_actividad').insert({
        lead_id: lead.id,
        tipo: 'vambe_webhook_unknown',
        descripcion: `❓ Evento Vambe no reconocido: "${type}" (normalized: "${norm}")`,
        metadata: { source: 'vambe', original_type: type, normalized: norm, data },
      })
    }
  }
}

/** Encuentra el lead del CRM por aiContactId o, fallback, por phone/email. */
async function findLead(supabase: Supabase, aiContactId: string | undefined, data: Record<string, unknown>): Promise<Lead | null> {
  if (aiContactId) {
    const { data: byId } = await supabase.from('leads').select('*').eq('vambe_contact_id', aiContactId).maybeSingle()
    if (byId) return byId as Lead
  }
  // Extraer teléfono de TODOS los campos posibles que Vambe puede usar según
  // el tipo de evento. message.received usa fromNumber/from_number, pero
  // message.sent puede usar toNumber/to_number/destination/contact_phone_number/
  // contact_phone, y a veces anidado en data.payload o data.contact.
  const payload = (data.payload || {}) as Record<string, unknown>
  const contact = (data.contact || {}) as Record<string, unknown>
  const phoneCandidatesRaw: string[] = [
    data.fromNumber, data.from_number, data.fromPhoneNumber,
    data.toNumber, data.to_number, data.toPhoneNumber,
    data.destination, data.destination_number,
    data.contact_phone_number, data.contact_phone, data.phone, data.phoneNumber,
    payload.fromNumber, payload.from_number, payload.toNumber, payload.to_number,
    payload.contact_phone_number, payload.contact_phone, payload.phone,
    contact.phone, contact.phoneNumber, contact.contact_phone_number,
  ].filter(v => typeof v === 'string' && v.length > 0) as string[]

  // El número del lead es el que NO sea nuestro channel
  const channelPhone = (process.env.VAMBE_CHANNEL_PHONE || '').replace(/[+\s\-()]/g, '')
  const candidatePhones = phoneCandidatesRaw
    .map(p => p.replace(/[+\s\-()]/g, ''))
    .filter(p => p && p !== channelPhone)
  for (const phone of candidatePhones) {
    // Match parcial — el sheet/CRM puede no tener prefijo +52
    const last10 = phone.slice(-10)
    // SAFETY: si last10 < 10 dígitos, el LIKE %X% matchearía CUALQUIER lead.
    // Mejor saltarse este número que riesgo de contaminar la BD.
    if (last10.length < 10) continue
    // Usar .limit(1) en vez de maybeSingle() para evitar null cuando hay
    // múltiples leads con el mismo last10 (ej: dos leads con el mismo phone
    // por duplicación histórica). Tomamos el más reciente.
    const { data: byPhones } = await supabase
      .from('leads')
      .select('*')
      .like('telefono', `%${last10}`)
      .order('created_at', { ascending: false })
      .limit(1)
    if (byPhones && byPhones.length > 0) return byPhones[0] as Lead
  }
  // Diagnóstico: si llegamos aquí sin match, dejar rastro mínimo en logs
  if (aiContactId || candidatePhones.length > 0) {
    console.warn('[vambe webhook] findLead sin match', {
      aiContactId,
      candidatePhones: candidatePhones.slice(0, 3),
      dataKeys: Object.keys(data).slice(0, 20),
    })
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
      // Desde 11-jun-2026 el form de Vambe ya no trae `phone` — lo tomamos
      // del payload del mensaje de WhatsApp (fromNumber = el contacto).
      if (!form.telefono) {
        const contactPhone = extractContactPhone(data, true)
        if (contactPhone) form.telefono = contactPhone
      }
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

  // Descripción super resumida — el detalle completo queda en metadata.
  const desc = isInbound
    ? `📥 cliente respondió`
    : `📨 Vambe envió mensaje`

  // Dedup robusto contra race conditions y retries de Vambe:
  //  1. Si Vambe nos da un message_id único, lo usamos como dedup_key.
  //     Buscamos en metadata->>message_id; si ya existe, skip total.
  //  2. Si no hay message_id, fallback al dedup por ventana de tiempo (3 min)
  //     consolidando mensajes consecutivos del mismo direction en un solo row
  //     con contador ×N.
  const messageId = (data.message_id || data.id || data.messageId
    || (data.payload as Record<string, unknown> | undefined)?.id
    || (data.payload as Record<string, unknown> | undefined)?.message_id
    || null) as string | null

  if (messageId) {
    // Ya existe activity con este mismo message_id? → skip (es retry)
    const { data: dupe } = await supabase
      .from('lead_actividad')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('tipo', 'vambe_message')
      .filter('metadata->>message_id', 'eq', messageId)
      .limit(1)
      .maybeSingle()
    if (dupe) {
      // Es un retry de Vambe — skip silenciosamente
      return
    }
  }

  // Dedup por ventana: buscar última activity del mismo direction
  const { data: lastActivity } = await supabase
    .from('lead_actividad')
    .select('id, descripcion, metadata, created_at')
    .eq('lead_id', lead.id)
    .eq('tipo', 'vambe_message')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const THREE_MIN_MS = 3 * 60_000
  const sameKind = lastActivity
    && (lastActivity as { descripcion?: string }).descripcion?.startsWith(isInbound ? '📥' : '📨')
  const recent = lastActivity
    && Date.now() - new Date((lastActivity as { created_at: string }).created_at).getTime() < THREE_MIN_MS

  if (sameKind && recent) {
    const prevMeta = (lastActivity as { metadata: Record<string, unknown> }).metadata || {}
    const count = ((prevMeta.count as number) || 1) + 1
    const messages = Array.isArray(prevMeta.messages) ? prevMeta.messages : []
    const messageIds = Array.isArray(prevMeta.message_ids) ? prevMeta.message_ids : []
    await supabase.from('lead_actividad').update({
      descripcion: `${desc} (×${count})`,
      metadata: {
        ...prevMeta, count,
        last_text: text.slice(0, 500),
        last_message_id: messageId,
        message_ids: messageId ? [...messageIds, messageId].slice(-20) : messageIds,
        messages: [...messages, { text: text.slice(0, 500), at: new Date().toISOString(), id: messageId }].slice(-20),
        source: 'vambe',
      },
    }).eq('id', (lastActivity as { id: string }).id)
  } else {
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'vambe_message',
      descripcion: desc,
      metadata: {
        source: 'vambe', type,
        direction: isInbound ? 'inbound' : 'outbound',
        text: text.slice(0, 500),
        message_id: messageId,
        message_ids: messageId ? [messageId] : [],
        count: 1,
        raw: data,
      },
    })
  }

  // ── BUG FIX (3 jun 2026): cuando Vambe (el bot o un humano del equipo)
  // envía un mensaje OUTBOUND, también debemos bumpear veces_contactado +
  // resetear ultimo_contacto en el lead — igual que cuando Fer clickea
  // "📨 Mensaje" desde /leads (que va por /api/leads/[id]/quick-action).
  //
  // Sin esto, los mensajes mandados por el bot Vambe (asistente Outbound
  // proactivo, o envíos manuales del equipo desde Vambe UI) no cuentan
  // como "contacto" en el CRM — el counter de días no se reinicia y el
  // lead nunca avanza a 2do/3er contacto.
  //
  // Solo aplica para outbound (envíos del lado nuestro). Inbound son
  // respuestas del cliente y NO deben bumpear veces_contactado.
  // Y solo si NO es un retry/dedup (sameKind+recent) — esos ya están
  // consolidados en la misma actividad.
  if (!isInbound && !(sameKind && recent)) {
    // FIX (3 jun 2026): evitar DOUBLE BUMP. Cuando Fer clickea "📨 Mensaje"
    // en el CRM, /quick-action bumpea veces_contactado +1 y crea una activity
    // template_sent. Luego Vambe nos manda webhook message.sent que vuelve a
    // entrar aquí. Sin guard, el counter sube +2 en una sola acción de Fer
    // (ej: 1er contacto → 3er contacto sin pasar por 2do).
    //
    // Lo mismo aplica al flow de aprobaciones (Outbound → Aprobar): el
    // endpoint /api/aprobaciones/[id]/approve también bumpea +1 y crea
    // template_sent. El webhook llega después y duplicaría el bump.
    //
    // Guard: si hay una actividad 'template_sent' para este lead en los
    // últimos 5 min, asumimos que el bump ya lo hizo el endpoint que disparó
    // el envío (quick-action o aprobaciones). Solo bumpeamos en el webhook
    // si NO hay template_sent reciente — eso indica que el mensaje vino del
    // bot Vambe proactivo o del equipo desde la UI de Vambe directamente.
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    const { data: recentTemplateSent } = await supabase
      .from('lead_actividad')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('tipo', 'template_sent')
      .gte('created_at', fiveMinAgo)
      .limit(1)
      .maybeSingle()
    const alreadyBumpedByEndpoint = !!recentTemplateSent

    if (!alreadyBumpedByEndpoint) {
      // ATOMIC FIX (4 jun 2026): antes el bump era read-modify-write,
      // race-condition si llegaban 2 webhooks en paralelo (ambos leían
      // el mismo valor y ambos hacían update al mismo +1 → un bump se
      // perdía). Ahora usamos RPC bump_lead_contacto que hace el
      // UPDATE atómico con veces_contactado = COALESCE(...,0) + 1.
      await supabase.rpc('bump_lead_contacto', {
        p_lead_id: lead.id,
        p_set_contactado: lead.status === 'nuevo',
      })
    }
  }

  // NOTA: REMOVIDO el auto-promote nuevo → contactado.
  // Fer pidió que los leads de Vambe se queden en 'nuevo' hasta que él
  // los mueva con una acción manual (Mensaje/Llamar) o el sistema lo haga
  // por aprobación explícita en Outbound.
  // Tracking 'ultimo_contacto' y 'veces_contactado' se mantiene si quieres
  // reactivarlo más adelante — por ahora omitimos el update completo.

  // Marcar responded_at en campaign recipients si este inbound es la primera
  // respuesta del cliente a una campaña reciente.
  if (isInbound) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: recipients } = await supabase
      .from('vambe_campaign_recipients')
      .select('id')
      .eq('lead_id', lead.id)
      .gte('sent_at', cutoff)
      .is('responded_at', null)
      .limit(10)
    if (recipients && recipients.length > 0) {
      await supabase
        .from('vambe_campaign_recipients')
        .update({ responded_at: new Date().toISOString() })
        .in('id', recipients.map(r => r.id))
    }

    // ─── NUEVO (7-jun 2026): alerta general "nuevo mensaje" a Slack para
    // los 5 stages clave que Fer quiere monitorear sin abrir Vambe.
    // Stages: Asistencia humana, Confirmados ✅, Llamadas ☎️, Contactados WA, Ganados.
    // Dedup: no alertar 2 veces para el mismo lead en <90 segundos
    // (mensajes consecutivos del mismo lead se agrupan en una sola alerta).
    if (lead.vambe_stage_id && NUEVO_MENSAJE_STAGES[lead.vambe_stage_id]) {
      const stageInfo = NUEVO_MENSAJE_STAGES[lead.vambe_stage_id]
      const ninetySecAgo = new Date(Date.now() - 90_000).toISOString()
      const { data: recentNmAlert } = await supabase
        .from('lead_actividad')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('tipo', 'nuevo_mensaje_alert')
        .gte('created_at', ninetySecAgo)
        .limit(1)
        .maybeSingle()
      if (!recentNmAlert) {
        // Marcar PRIMERO (idempotencia ante doble-webhook) y luego enviar
        await supabase.from('lead_actividad').insert({
          lead_id: lead.id,
          tipo: 'nuevo_mensaje_alert',
          descripcion: `🔔 Alerta Slack: nuevo mensaje en ${stageInfo.label}`,
          metadata: {
            stage_id: lead.vambe_stage_id,
            stage_key: stageInfo.key,
            stage_label: stageInfo.label,
            text_preview: (text || '').slice(0, 200),
          },
        })
        // Fire-and-forget para no bloquear el webhook (Vambe espera 200 OK rápido)
        alertNuevoMensajeVambe({
          lead,
          message: text,
          stageKey: stageInfo.key,
          stageLabel: stageInfo.label,
        }).catch(e => {
          console.error('[nuevo-mensaje alert] error', e)
        })
      }
    }

    // Vambe 1: si el lead está en Asistencia Humana y no ha tenido actividad
    // del lado del bot/equipo en >7 días, es un lead "abandonado" que vuelve.
    // Alertamos a Slack para que Fer lo retome. (No reactivamos el bot
    // automáticamente — eso requeriría mover stage en Vambe via API.)
    if (lead.vambe_stage_id === STAGE_ATENCION_HUMANA) {
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
      const { data: lastOutbound } = await supabase
        .from('lead_actividad')
        .select('created_at')
        .eq('lead_id', lead.id)
        .or('tipo.eq.vambe_message,tipo.eq.atencion_humana_attended')
        .like('descripcion', '📨%')   // solo mensajes outbound del bot
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const lastActivityAt = lastOutbound ? new Date((lastOutbound as { created_at: string }).created_at).getTime() : 0
      const isStale = !lastActivityAt || (Date.now() - lastActivityAt > SEVEN_DAYS_MS)
      if (isStale) {
        // Idempotencia: no alertar más de una vez por día
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const { data: recentAlert } = await supabase
          .from('lead_actividad')
          .select('id')
          .eq('lead_id', lead.id)
          .eq('tipo', 'lead_viejo_reactivado')
          .gte('created_at', oneDayAgo)
          .limit(1)
          .maybeSingle()
        if (!recentAlert) {
          await alertLeadReactivated(supabase, lead, text).catch(e => {
            console.error('[Vambe 1] alertLeadReactivated error', e)
          })
        }
      }
    }

    // Vambe 5: si el lead tiene una llamada agendada dentro de las próximas 4h
    // y acaba de responder, es probable que esté pidiendo reagendar (o avisando
    // que no podrá). Disparamos alerta a Slack para que Fer pueda actuar.
    // Idempotente por timestamp del lead (no alertar dos veces para la misma llamada).
    if (lead.llamada_at && lead.status === 'llamada_agendada') {
      const llamadaAt = new Date(lead.llamada_at).getTime()
      const now = Date.now()
      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
      const isWithinReminderWindow = llamadaAt > now && (llamadaAt - now) <= FOUR_HOURS_MS
      if (isWithinReminderWindow) {
        // Idempotencia: no alertar si ya hay una alerta para esta llamada
        const { data: existingAlert } = await supabase
          .from('lead_actividad')
          .select('id')
          .eq('lead_id', lead.id)
          .eq('tipo', 'reminder_response_alert')
          .filter('metadata->>llamada_at', 'eq', lead.llamada_at)
          .limit(1)
          .maybeSingle()
        if (!existingAlert) {
          await alertReminderResponse(supabase, lead, text, lead.llamada_at).catch(e => {
            console.error('[Vambe 5] alertReminderResponse error', e)
          })
        }
      }
    }
  }
}

/**
 * Vambe 1: alerta a Slack cuando un lead viejo en Asistencia Humana vuelve a
 * escribir. El bot no se reactiva automáticamente (no hay API pública de Vambe
 * para mover stage), pero al menos Fer se entera y puede atenderlo.
 */
async function alertLeadReactivated(
  supabase: Supabase,
  lead: Lead,
  message: string,
): Promise<void> {
  const webhookUrl = process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL
    || await (async () => {
      const { data } = await supabase.from('system_settings').select('value').eq('key', 'slack_alertas_vambe_webhook').maybeSingle()
      return (data as { value?: string } | null)?.value
    })()
    || process.env.SLACK_ALERT_WEBHOOK_URL
  if (!webhookUrl) return

  const base = process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
  const leadUrl = `${base}/leads/${lead.id}`

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔔 Lead viejo volvió a escribir', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Lead:*\n${lead.nombre || lead.email || '(sin nombre)'}` },
        { type: 'mrkdwn', text: `*Número:*\n${lead.telefono || '—'}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Estaba en Asistencia Humana sin actividad >7 días — ahora escribió:*\n> ${(message || '(sin texto)').slice(0, 500).replace(/\n/g, '\n> ')}` },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${lead.empresa ? `🏢 ${lead.empresa}` : ''}${lead.vacante ? ` · 💼 ${lead.vacante}` : ''}` },
      ],
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Ver lead' }, url: leadUrl, style: 'primary' },
      ],
    },
  ]

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `🔔 Lead viejo volvió: ${lead.nombre || lead.email}`, blocks }),
    })
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'lead_viejo_reactivado',
      descripcion: '🔔 Lead viejo en Asistencia Humana volvió a escribir — alerta Slack',
      metadata: { message: message.slice(0, 300) },
    })
  } catch (e) {
    console.error('[Vambe 1] fetch error', e)
  }
}

/**
 * Vambe 5: alerta a Slack cuando un lead responde dentro de la ventana del
 * reminder (4h antes de la llamada). Le da contexto a Fer para decidir si
 * reagenda, confirma o no hace nada.
 */
async function alertReminderResponse(
  supabase: Supabase,
  lead: Lead,
  message: string,
  llamadaAt: string,
): Promise<void> {
  const webhookUrl = process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL
    || await (async () => {
      const { data } = await supabase.from('system_settings').select('value').eq('key', 'slack_alertas_vambe_webhook').maybeSingle()
      return (data as { value?: string } | null)?.value
    })()
    || process.env.SLACK_ALERT_WEBHOOK_URL
  if (!webhookUrl) {
    console.warn('[Vambe 5] no webhook configurado')
    return
  }

  const base = process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
  const leadUrl = `${base}/leads/${lead.id}`
  const fmtTime = new Date(llamadaAt).toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    dateStyle: 'medium', timeStyle: 'short',
  })

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '⏰ Lead respondió al reminder', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Lead:*\n${lead.nombre || lead.email || '(sin nombre)'}` },
        { type: 'mrkdwn', text: `*Llamada:*\n${fmtTime}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Mensaje del lead:*\n> ${(message || '(sin texto)').slice(0, 500).replace(/\n/g, '\n> ')}` },
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Ver lead' }, url: leadUrl },
      ],
    },
  ]

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `⏰ Lead respondió al reminder: ${lead.nombre || lead.email}`, blocks }),
    })
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'reminder_response_alert',
      descripcion: '⏰ Alerta Slack: lead respondió al reminder',
      metadata: { llamada_at: llamadaAt, message: message.slice(0, 300) },
    })
  } catch (e) {
    console.error('[Vambe 5] fetch error', e)
  }
}

/**
 * Extrae el teléfono del CONTACTO desde el payload del webhook.
 * Necesario desde el 11-jun-2026: el formulario de Vambe dejó de incluir
 * el campo `phone`, pero el número real siempre viaja en el evento de
 * WhatsApp (fromNumber en inbound, toNumber en outbound, phone en tickets).
 * Prioriza campos según dirección para no capturar el número del canal.
 */
function extractContactPhone(data: Record<string, unknown>, isInbound: boolean): string | null {
  const payload = (data.payload || {}) as Record<string, unknown>
  const contact = (data.contact || {}) as Record<string, unknown>
  // BUG FIX (15-jun-2026): Vambe trae el teléfono real del contacto en
  // `ai_contact.phone` cuando llega un evento de stage.changed o ticket.*.
  // Antes no lo buscábamos ahí y todos los leads promovidos por stage
  // (sin pasar por message.received con fromNumber) entraban sin teléfono.
  const aiContact = (data.ai_contact || data.aiContact || {}) as Record<string, unknown>
  const inboundFirst = [
    data.fromNumber, data.from_number, data.fromPhoneNumber, payload.fromNumber, payload.from_number,
  ]
  const outboundFirst = [
    data.toNumber, data.to_number, data.toPhoneNumber, payload.toNumber, payload.to_number,
  ]
  const generic = [
    data.contact_phone_number, data.contact_phone, data.phone, data.phoneNumber,
    payload.contact_phone_number, payload.contact_phone, payload.phone,
    contact.phone, contact.phoneNumber, contact.contact_phone_number,
    aiContact.phone, aiContact.phoneNumber, aiContact.platform_contact_username,
  ]
  const ordered = (isInbound ? [...inboundFirst, ...generic, ...outboundFirst] : [...outboundFirst, ...generic, ...inboundFirst])
    .filter(v => typeof v === 'string' && (v as string).length > 0) as string[]

  const channelPhone = (process.env.VAMBE_CHANNEL_PHONE || '').replace(/[+\s\-()]/g, '')
  for (const raw of ordered) {
    const digits = raw.replace(/[+\s\-()]/g, '')
    if (digits.length < 10) continue
    if (channelPhone && digits.slice(-10) === channelPhone.slice(-10)) continue
    const normalized = normalizeMexicanPhone(raw)
    if (normalized) return normalized
  }
  return null
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

  // Defensa extra: si el form quedó sin teléfono (Vambe lo quitó del
  // formulario el 11-jun-2026), intentar extraerlo del evento crudo.
  if (!form.telefono && pending?.raw_event) {
    const contactPhone = extractContactPhone(pending.raw_event as Record<string, unknown>, true)
    if (contactPhone) form.telefono = contactPhone
  }

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
  if (form.email) fields.email = form.email.toLowerCase().trim()
  if (form.telefono) fields.telefono = normalizeMexicanPhone(form.telefono) || form.telefono
  if (form.vacante) fields.vacante = normalizeVacante(form.vacante)
  if (form.presupuesto) fields.presupuesto = form.presupuesto
  if (form.rol) fields.puesto = normalizePuesto(form.rol)
  const company = extractCompanyFromEmail(form.email)
  if (company) fields.empresa = company
  const notas = buildNotasFromForm(form)
  if (notas) fields.notas = notas

  // Campos que SIEMPRE se sobreescriben para mantener data limpia.
  // `telefono` también — porque Vambe siempre tiene el actual y el viejo puede ser obsoleto.
  const NORMALIZED_FIELDS = new Set(['vacante', 'puesto', 'notas', 'telefono'])

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
  } else {
    // Crear nuevo lead. Si no hay email pero sí teléfono, generamos un email
    // placeholder vambe-{telefono}@chambas.ai para no perder el lead.
    let email = form.email
    if (!email) {
      const tel = form.telefono || fields.telefono
      if (!tel) {
        // No hay ni email ni teléfono — no podemos crear nada útil
        return { lead: null, created: false, form }
      }
      const digits = String(tel).replace(/\D/g, '').slice(-10)
      email = `vambe-${digits}@chambas.ai`
    }
    const insert: Record<string, unknown> = {
      ...fields,
      email,
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

  // NOTA: REMOVIDO el auto-promote nuevo→contactado en ticket.created.
  // Mismo principio que message.received — el lead debe quedarse en 'nuevo'
  // hasta que Fer haga una acción manual (Mensaje/Llamar) o apruebe en /outbound.
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
 *
 * Default hardcoded (los UUIDs reales del pipeline en uso). Si querés overridear
 * a nivel ambiente, configurá `VAMBE_STAGE_MAP` con JSON; mergea encima del default.
 *
 * REGLA: cualquier contacto que la AI tocó (sea cual sea su stage) entra al CRM
 * como `nuevo`. Solo "Ganados" / "Perdidos" son terminales. La idea es que el
 * vendedor humano vea TODO lo que pasó por Vambe — Lanzamiento incluido — y
 * decida si vale la pena re-engaging un lead que el bot dejó atrás.
 */
const DEFAULT_STAGE_MAP: Record<string, Lead['status']> = {
  '96c42cda-2828-45db-973c-3bc63a8141fd': 'nuevo',              // Interesado
  '05b9af0a-9bcb-4faf-a114-bdd47517a97a': 'nuevo',              // Lanzamiento (engagement inicial)
  'dd41a38e-3b22-42f3-a6d3-b130b9ca449f': 'nuevo',              // Asistencia Humana
  '5847352c-f983-4e8b-b635-b19797d031a8': 'nuevo',              // Contactados via WhatsApp
  '971fe009-72d1-44fb-932b-aa94adcec4db': 'llamada_agendada',   // Agendados Consultoría
  '2fc44415-960f-4dbd-b65b-1500636fc41a': 'llamada_agendada',   // Confirmados
  'cd0ab574-c844-4346-bea3-4ddd084fcb92': 'llamada_agendada',   // Llamadas
  'c86a7911-ef9d-4f6d-8c90-3e9a9a4d6b50': 'convertido',         // Ganados
  '9a43e657-b5cc-4baf-a503-1e0b37b9b366': 'descartado',         // Perdidos
}

function getStageMap(): Record<string, Lead['status']> {
  const raw = process.env.VAMBE_STAGE_MAP
  if (!raw) return DEFAULT_STAGE_MAP
  try {
    const override = JSON.parse(raw) as Record<string, Lead['status']>
    return { ...DEFAULT_STAGE_MAP, ...override }
  } catch {
    return DEFAULT_STAGE_MAP
  }
}

/** Keys que probablemente contienen una fecha de llamada/cita. */
const DATE_KEY_PATTERNS = [
  /llamada/i, /appointment/i, /scheduled/i, /meeting/i, /booking/i,
  /\bfecha/i, /\bcita/i, /\bdate/i, /\btime/i,
  /start[._]?(at|time)?$/i, /next[._]?call/i,
]

/**
 * Busca recursivamente en el payload cualquier campo cuya key sugiera fecha
 * de llamada y cuyo valor parsee como Date válido. Mira hasta 3 niveles
 * de anidamiento. Devuelve la PRIMERA fecha futura (o cualquier válida).
 */
function extractLlamadaAt(data: unknown, depth = 3): string | null {
  if (!data || typeof data !== 'object' || depth < 0) return null
  const obj = data as Record<string, unknown>

  // Primera pasada: keys obvias
  for (const [key, v] of Object.entries(obj)) {
    const looksLikeDate = DATE_KEY_PATTERNS.some(p => p.test(key))
    if (!looksLikeDate) continue
    const parsed = tryParseDate(v)
    if (parsed) return parsed
  }

  // Segunda pasada: recursión en sub-objetos
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = extractLlamadaAt(v, depth - 1)
      if (found) return found
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object') {
          const found = extractLlamadaAt(item, depth - 1)
          if (found) return found
        }
      }
    }
  }

  return null
}

function tryParseDate(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    if (!isNaN(d.getTime()) && d.getFullYear() > 2020 && d.getFullYear() < 2100) {
      return d.toISOString()
    }
  }
  if (typeof v === 'number' && v > 0) {
    const ms = v < 1e12 ? v * 1000 : v
    const d = new Date(ms)
    if (!isNaN(d.getTime()) && d.getFullYear() > 2020 && d.getFullYear() < 2100) {
      return d.toISOString()
    }
  }
  return null
}

/**
 * Busca menciones de fechas/horas en texto plano de mensajes.
 * Útil cuando Vambe AI confirma: "Perfecto, agendamos para mañana 11:30 am".
 */
function extractDateFromMessages(messages: Array<{ message: string; created_at: string }>): string | null {
  // Buscar en los últimos 10 mensajes (de más reciente a más viejo)
  const recent = messages.slice(0, 10)

  for (const msg of recent) {
    const text = msg.message || ''
    if (!text) continue

    // Patrones que sugieren confirmación de llamada
    const isAgendaMsg = /(agendad[ao]|confirmad[ao]|cita|llamada|reunion|reunion[ée]).{0,40}(am|pm|hora|hrs|hr|:|\d)/i.test(text)
    if (!isAgendaMsg) continue

    // Patrón: hora estilo "11:30 am" o "13:45"
    const hm = text.match(/(\b\d{1,2}):(\d{2})\s*(am|pm|hrs?)?\b/i)
    if (!hm) continue
    let hour = parseInt(hm[1], 10)
    const minute = parseInt(hm[2], 10)
    const ampm = (hm[3] || '').toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0

    // Patrón: día (hoy/mañana/lunes/martes/etc o fecha "30 de mayo")
    const baseDate = new Date(msg.created_at)
    let targetDate = new Date(baseDate)

    if (/\bma[nñ]ana\b/i.test(text)) {
      targetDate.setDate(targetDate.getDate() + 1)
    } else if (/\bhoy\b/i.test(text)) {
      // mantener mismo día
    } else {
      // Detectar día de la semana — palabras COMPLETAS, no prefijos.
      // FIX (4 jun 2026): antes el key `mi` con `\\b${name}\\w*\\b` matcheaba
      // "miércoles" pero también "mil", "minuto", "misma". Quitamos los
      // prefijos ambiguos `mi`/`sab` y matcheamos solo palabras completas.
      const dayNames: Record<string, number> = {
        domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3,
        jueves: 4, viernes: 5, sábado: 6, sabado: 6,
      }
      for (const [name, dow] of Object.entries(dayNames)) {
        // Match exacto de la palabra (sin \w* después).
        if (new RegExp(`\\b${name}\\b`, 'i').test(text)) {
          const currentDow = targetDate.getDay()
          const diff = (dow - currentDow + 7) % 7 || 7
          targetDate.setDate(targetDate.getDate() + diff)
          break
        }
      }
    }

    targetDate.setHours(hour, minute, 0, 0)
    if (!isNaN(targetDate.getTime())) {
      return targetDate.toISOString()
    }
  }
  return null
}

/**
 * Solo avanzar el status en el funnel — nunca retroceder.
 * 'descartado' es independiente: si target es descartado, siempre se aplica
 * (excepto si ya estaba descartado).
 */
function shouldAdvanceStatus(current: Lead['status'], target: Lead['status']): boolean {
  const order: Lead['status'][] = [
    'nuevo', 'contactado', 'llamada_agendada', 'no_show_llamada',
    'presentacion_enviada', 'espera_aprobacion', 'liga_pago_enviada', 'convertido', 'cliente_recurrente',
  ]
  if (target === 'descartado') return current !== 'descartado'
  const ci = order.indexOf(current)
  const ti = order.indexOf(target)
  if (ci === -1 || ti === -1) return current !== target
  return ti > ci
}

async function handleStageChanged(supabase: Supabase, aiContactId: string | undefined, data: Record<string, unknown>) {
  // Formato A (legacy): data.new_stage_id / data.newStageId / data.stageId
  // Formato B (TicketStageHistoryEntity): data.stage.id / data.stage_id
  const stageObj = (data.stage || null) as { id?: string; name?: string } | null
  const newStageId = ((stageObj?.id)
    || data.stage_id
    || data.new_stage_id
    || data.newStageId
    || data.stageId
    || '') as string

  const prevStageObj = (data.previous_stage || null) as { id?: string; name?: string } | null
  const prevEntityData = (data.previous_entity_data || null) as Record<string, unknown> | null
  const previousStageId = ((prevStageObj?.id)
    || data.previous_stage_id
    || data.previousStageId
    || (prevEntityData?.stage_id as string)
    || ((prevEntityData?.stage as { id?: string } | null)?.id)
    || '') as string

  const map = getStageMap()
  const mappedStatus = map[newStageId]
  // Si el stage no está en el map (stage nuevo en Vambe), loguear para que
  // podamos agregarlo al map. Antes era silent skip y stages nuevos quedaban
  // sin avanzar al lead.
  if (!mappedStatus && newStageId) {
    console.warn(`[vambe] Stage no mapeado: "${newStageId}" — agregar a DEFAULT_STAGE_MAP o VAMBE_STAGE_MAP env var. Lead queda en estado actual.`)
  }

  // Si el lead aún no existe en el CRM, intentar promoverlo desde el pending
  // EN CUALQUIER stage change (no solo cuando target=='nuevo'). Razón: el lead
  // puede haber completado el form en Lanzamiento o cualquier otra etapa antes
  // de que la AI lo mueva a Interesado. Si esperamos a Interesado para
  // promoverlo, leads que se quedan en Lanzamiento nunca entran al CRM.
  let lead = await findLead(supabase, aiContactId, data)
  let promoted = false

  if (!lead && aiContactId) {
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
      // No hay pending form en cache. Fallback: pedir mensajes a Vambe directo
      // para encontrar el form y crear el lead de inmediato.
      try {
        const messages = await getMessages(aiContactId, 100)
        let form: FormFields | null = null
        for (const m of messages) {
          const parsed = parseFormMessage(m.message || '')
          if (parsed) { form = parsed; break }
        }
        if (form && form.email) {
          await stashPendingForm(supabase, aiContactId, form, data)
          const promo2 = await promotePendingLead(supabase, aiContactId)
          if (promo2.lead) {
            lead = promo2.lead
            promoted = promo2.created
            if (promo2.created) {
              await supabase.from('lead_actividad').insert({
                lead_id: lead.id,
                tipo: 'vambe_lead_promoted',
                descripcion: '🚀 Lead promovido en stage.changed (fetched form de Vambe API)',
                metadata: { source: 'vambe-fallback', stage_id: newStageId, form },
              })
            }
          }
        } else {
          console.warn(`Vambe stage→Interesado sin form ni cacheado ni en API. aiContactId=${aiContactId}`)
        }
      } catch (e) {
        console.error('Vambe fallback fetch error', e)
      }
    }
  }

  if (!lead) return

  const updates: Record<string, unknown> = { vambe_stage_id: newStageId }
  // Solo avanzar el status — nunca retroceder (un lead convertido no vuelve a nuevo
  // aunque Vambe diga Interesado).
  if (mappedStatus && mappedStatus !== lead.status && shouldAdvanceStatus(lead.status, mappedStatus)) {
    updates.status = mappedStatus
    updates.status_changed_at = new Date().toISOString()
  }

  // Si la nueva stage corresponde a "llamada agendada", intentar extraer fecha/hora
  let llamadaAtSaved: string | null = null
  if (mappedStatus === 'llamada_agendada') {
    // 1) Buscar en el payload del stage.changed
    let llamadaAt = extractLlamadaAt(data)
    // 2) Si no, buscar en los mensajes recientes del contacto
    if (!llamadaAt && aiContactId) {
      try {
        const messages = await getMessages(aiContactId, 30)
        llamadaAt = extractDateFromMessages(messages.map(m => ({
          message: m.message || '',
          created_at: m.created_at,
        })))
      } catch (e) {
        console.warn('No pude pedir mensajes para extraer fecha:', e)
      }
    }
    if (llamadaAt) {
      updates.llamada_at = llamadaAt
      llamadaAtSaved = llamadaAt
    }
    // Asignar tipo_llamada según UUID de stage
    const tipo = tipoLlamadaForStage(newStageId)
    if (tipo) updates.tipo_llamada = tipo
  }

  await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'vambe_stage_change',
    descripcion: `Pipeline Vambe: ${previousStageId || '?'} → ${newStageId}${mappedStatus ? ` (CRM status → ${mappedStatus})` : ''}${llamadaAtSaved ? ` 📅 ${llamadaAtSaved}` : ''}${promoted ? ' · nuevo lead' : ''}`,
    metadata: { source: 'vambe', llamada_at: llamadaAtSaved, promoted, ...data },
  })

  await supabase.from('leads').update(updates).eq('id', lead.id)

  // ── Dedupe de eventos en Google Calendar (prevención de llamadas duplicadas) ──
  // Cuando un lead reagenda en Vambe, el bot crea un evento nuevo en GCal
  // pero el evento previo NO se borra automáticamente (Vambe no le pasa el
  // event_id viejo al webhook). Para evitar que el calendario quede con 2+
  // llamadas para el mismo lead, busco eventos futuros que matcheen al lead
  // (por teléfono o nombre) y dejo solo el más cercano al llamada_at canónico.
  // Best-effort, no bloquea el response si falla.
  //
  // FIX (24-jun-2026, caso Maricela 528126592565): antes solo corría dedupe si
  // el webhook traía un llamadaAtSaved nuevo Y el lead acababa de moverse a
  // llamada_agendada. En reagendas dentro de Confirmados/Llamadas, Vambe NO
  // pasaba llamada_at nuevo → el dedupe se saltaba y los duplicados quedaban
  // para siempre. Ahora también disparamos dedupe usando el llamada_at
  // existente del lead si está en cualquier stage de llamada.
  const stageIsCall = mappedStatus === 'llamada_agendada'
    || lead.status === 'llamada_agendada'
    || newStageId === STAGE_DEMO_AGENDADA
    || newStageId === STAGE_DEMO_CONFIRMADA
    || newStageId === STAGE_LLAMADA_COMERCIAL
  const llamadaAtForDedupe = llamadaAtSaved || lead.llamada_at
  if (stageIsCall && llamadaAtForDedupe) {
    try {
      const leadForDedupe = {
        nombre: lead.nombre,
        telefono: lead.telefono,
      }
      const { dedupeFutureCallEventsForLead } = await import('@/lib/googleCalendar')
      const dedupe = await dedupeFutureCallEventsForLead(
        supabase,
        leadForDedupe,
        llamadaAtForDedupe,
      )
      if (dedupe.deleted.length > 0) {
        // Guardar el event_id "canónico" en el lead (el winner)
        if (dedupe.keptEventId) {
          await supabase.from('leads')
            .update({ google_calendar_event_id: dedupe.keptEventId })
            .eq('id', lead.id)
        }
        await supabase.from('lead_actividad').insert({
          lead_id: lead.id,
          tipo: 'llamada_cancelada_reagendada',
          descripcion: `🧹 Dedupe GCal: borrado ${dedupe.deleted.length} evento(s) previo(s) — kept ${dedupe.keptEventId?.slice(0, 8) || 'none'}`,
          metadata: {
            source: 'vambe_stage_changed',
            new_llamada_at: llamadaAtSaved,
            kept_event_id: dedupe.keptEventId,
            deleted_event_ids: dedupe.deleted,
            total_found: dedupe.totalFound,
          },
        })
      }
    } catch (e) {
      console.error('[vambe webhook] dedupe GCal failed:', e)
    }
  }

  // ── Alertas a Slack para eventos críticos ──
  // No bloqueamos el response — corre best-effort en paralelo.
  fireSlackAlertsForStageChange(newStageId, { ...lead, ...updates } as Lead, promoted, previousStageId).catch(e => {
    console.error('Slack alert error', e)
  })

  // ── Marcar outcome en campaign recipients (si este lead recibió alguna campaña) ──
  await markCampaignOutcome(supabase, lead.id, newStageId, mappedStatus).catch(e => {
    console.error('campaign outcome error', e)
  })
}

/** Dispara alertas a Slack según la stage que llegó. No-op si no hay webhook configurado. */
async function fireSlackAlertsForStageChange(newStageId: string, lead: Lead, promoted: boolean, previousStageId?: string) {
  if (newStageId === STAGE_ATENCION_HUMANA) {
    // GUARD: Si el lead venía de un flujo confirmado (llamada agendada o Confirmados ✅),
    // el bot la escaló por error — silenciamos la alerta SOS porque la "fricción" es solo
    // que Fer debe llamar manualmente, no que la AI no pudo continuar.
    //
    // Detección por stage previo y por status interno (ambos en paralelo, defensivo):
    //   - prev: Llamadas ☎️, Agendados Consultoría 📆, Confirmados ✅
    //   - status: llamada_agendada / llamada_con_dapta / presentacion_enviada
    const cameFromCallFlow =
      previousStageId === STAGE_LLAMADA_COMERCIAL ||
      previousStageId === STAGE_DEMO_AGENDADA ||
      previousStageId === STAGE_DEMO_CONFIRMADA
    const statusIsCallFlow =
      lead.status === 'llamada_agendada' ||
      lead.status === 'llamada_con_dapta' ||
      lead.status === 'presentacion_enviada'

    if (cameFromCallFlow || statusIsCallFlow) {
      const supabase = createServiceClient()
      await supabase.from('lead_actividad').insert({
        lead_id: lead.id,
        tipo: 'vambe_alerta_silenciada',
        descripcion: '🔇 SOS silenciado — lead venía confirmado / con llamada agendada (Vambe escaló por error)',
        metadata: {
          previous_stage_id: previousStageId,
          new_stage_id: newStageId,
          status: lead.status,
          reason: cameFromCallFlow ? 'previous_stage_in_call_flow' : 'status_in_call_flow',
        },
      })
      console.log(`[Vambe SOS guard] Lead ${lead.id} venía de flujo confirmado (prev=${previousStageId}, status=${lead.status}) — alerta silenciada`)
      return
    }

    // Crear ticket de atención humana + alerta a #alertas-vambe con resumen
    // del último mensaje y botones Atendido/Dismiss.
    const supabase = createServiceClient()

    // Buscar último mensaje inbound del cliente (lo que provocó la escalación)
    const { data: lastMsg } = await supabase
      .from('lead_actividad')
      .select('metadata, descripcion')
      .eq('lead_id', lead.id)
      .eq('tipo', 'vambe_message')
      .like('descripcion', '📥%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastMessage = lastMsg
      ? (((lastMsg as { metadata?: { text?: string; last_text?: string } }).metadata?.text)
        || ((lastMsg as { metadata?: { text?: string; last_text?: string } }).metadata?.last_text)
        || null)
      : null

    // Idempotente: si ya hay un ticket pending para este lead, no creamos otro
    const { data: existingTicket } = await supabase
      .from('vambe_atencion_tickets')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('status', 'pending')
      .maybeSingle()
    if (existingTicket) {
      console.log('Asistencia Humana: ticket pending ya existe para lead', lead.id, '— skip Slack')
      return
    }

    // Crear ticket
    const { data: ticket, error: ticketErr } = await supabase
      .from('vambe_atencion_tickets')
      .insert({
        lead_id: lead.id,
        status: 'pending',
        last_message: lastMessage,
        vambe_stage_id: newStageId,
      })
      .select('id')
      .single()
    if (ticketErr || !ticket) {
      console.error('Error creando atencion ticket:', ticketErr)
      // Fallback al alert legacy si no se puede crear ticket
      await alertAtencionHumana({
        leadId: lead.id, nombre: lead.nombre, email: lead.email,
        telefono: lead.telefono, vacante: lead.vacante, empresa: lead.empresa,
        inboxUrl: null,
      })
      return
    }

    await alertAtencionHumanaVambe({
      ticketId: (ticket as { id: string }).id,
      lead: {
        id: lead.id, nombre: lead.nombre, email: lead.email,
        telefono: lead.telefono, empresa: lead.empresa,
        vacante: lead.vacante, presupuesto: lead.presupuesto,
      },
      lastMessage,
    })
  } else if (newStageId === STAGE_GANADOS) {
    await alertVentaCerrada({
      leadId: lead.id,
      nombre: lead.nombre,
      email: lead.email,
      empresa: lead.empresa,
      monto: lead.monto || 1160,
    })
  } else if (promoted && lead.presupuesto === '10000_plus') {
    // Lead nuevo high-value recién promovido
    await alertHighValueLead({
      leadId: lead.id,
      nombre: lead.nombre,
      email: lead.email,
      empresa: lead.empresa,
      vacante: lead.vacante,
      presupuesto: lead.presupuesto,
    })
  }
}

/**
 * Si este lead ha sido recipient de alguna campaign reciente, marcar el outcome
 * (responded_at / scheduled_call_at / paid_at) en vambe_campaign_recipients.
 * Lookback: 30 días para evitar atribuir a campaigns muy viejas.
 */
async function markCampaignOutcome(supabase: Supabase, leadId: string, newStageId: string, mappedStatus: Lead['status'] | undefined) {
  // Determinar qué outcome marcar
  let updateField: 'scheduled_call_at' | 'paid_at' | 'responded_at' | null = null
  if (mappedStatus === 'llamada_agendada') updateField = 'scheduled_call_at'
  else if (mappedStatus === 'convertido' || newStageId === STAGE_GANADOS) updateField = 'paid_at'
  // (responded_at se setea desde handleMessage, no acá)
  if (!updateField) return

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recipients } = await supabase
    .from('vambe_campaign_recipients')
    .select('id')
    .eq('lead_id', leadId)
    .gte('sent_at', cutoff)
    .is(updateField, null)
    .limit(10)

  if (!recipients || recipients.length === 0) return

  await supabase
    .from('vambe_campaign_recipients')
    .update({ [updateField]: new Date().toISOString() })
    .in('id', recipients.map(r => r.id))
}
