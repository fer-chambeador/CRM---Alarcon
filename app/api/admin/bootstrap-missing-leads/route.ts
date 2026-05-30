import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { getMessages, getContactsByDays } from '@/lib/vambe'
import { extractCompanyFromEmail, normalizeVacante } from '@/lib/vambeNormalize'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/admin/bootstrap-missing-leads?ids=<csv>&dry=true|false&debug=true|false&synthetic=true|false
 *
 * ONE-SHOT endpoint para sembrar leads atascados afuera del CRM
 * (Vambe outbound-initiated, sin form, posiblemente sin email).
 *
 * - SÓLO crea (no update/no delete)
 * - Detecta phone+stage desde getContactsByDays(7) en Vambe
 * - Mapea stage UUID → status del CRM (Interesado→nuevo, Llamadas/Agendados→llamada_agendada)
 * - Parsea fecha de llamada desde outbound messages
 * - Si synthetic=true y no hay email, usa placeholder
 */
const KNOWN_MISSING_IDS = [
  'f3373f02-bec7-4cb9-a49a-9dbd1352c0f1',
  '6ea94e31-f6ed-407a-b38c-7638e77c0045',
  'ab46c4e5-f6e0-4b76-8b57-825b08b6f46d',
]

const STAGE_INTERESADO        = '96c42cda-2828-45db-973c-3bc63a8141fd'
const STAGE_DEMO_AGENDADA     = '971fe009-72d1-44fb-932b-aa94adcec4db'
const STAGE_DEMO_CONFIRMADA   = '2fc44415-960f-4dbd-b65b-1500636fc41a'
const STAGE_LLAMADA_COMERCIAL = 'cd0ab574-c844-4346-bea3-4ddd084fcb92'
const STAGE_GANADOS           = 'c86a7911-ef9d-4f6d-8c90-3e9a9a4d6b50'
const STAGE_PERDIDOS          = '9a43e657-b5cc-4baf-a503-1e0b37b9b366'

function stageToStatus(stageId: string | null | undefined): { status: Lead['status']; tipo_llamada?: 'demo' | 'comercial'; mapped: boolean } {
  if (!stageId) return { status: 'nuevo', mapped: false }
  if (stageId === STAGE_INTERESADO) return { status: 'nuevo', mapped: true }
  if (stageId === STAGE_DEMO_AGENDADA) return { status: 'llamada_agendada', tipo_llamada: 'demo', mapped: true }
  if (stageId === STAGE_DEMO_CONFIRMADA) return { status: 'llamada_agendada', tipo_llamada: 'demo', mapped: true }
  if (stageId === STAGE_LLAMADA_COMERCIAL) return { status: 'llamada_agendada', tipo_llamada: 'comercial', mapped: true }
  if (stageId === STAGE_GANADOS) return { status: 'convertido', mapped: true }
  if (stageId === STAGE_PERDIDOS) return { status: 'descartado', mapped: true }
  return { status: 'nuevo', mapped: false }
}

function extractDateFromMessages(messages: Array<{ message: string; created_at: string; direction: string }>): string | null {
  const recent = messages.slice(0, 15)
  for (const msg of recent) {
    const text = msg.message || ''
    if (!text) continue
    const isAgendaMsg = /(agendad[ao]|confirmad[ao]|cita|llamada|reunion|reunion[ée])\b/i.test(text)
      || /\b(perfecto|excelente|listo)\b.*\b(am|pm)\b/i.test(text)
    if (!isAgendaMsg) continue

    const hm = text.match(/(\b\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    if (!hm) continue
    let hour = parseInt(hm[1], 10)
    const minute = parseInt(hm[2] || '0', 10)
    const ampm = (hm[3] || '').toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0

    const baseDate = new Date(msg.created_at)
    const targetDate = new Date(baseDate)

    if (/\bma[nñ]ana\b/i.test(text)) {
      targetDate.setDate(targetDate.getDate() + 1)
    } else if (/\bhoy\b/i.test(text)) {
      // same day
    } else {
      const dayNames: Record<string, number> = {
        domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6,
      }
      let matched = false
      for (const [name, dow] of Object.entries(dayNames)) {
        if (new RegExp(`\\b${name}\\b`, 'i').test(text)) {
          const currentDow = targetDate.getDay()
          const diff = (dow - currentDow + 7) % 7 || 7
          targetDate.setDate(targetDate.getDate() + diff)
          matched = true
          break
        }
      }
      // Pattern "5 de junio" o "el 5 de junio"
      if (!matched) {
        const monthNames: Record<string, number> = {
          enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
        }
        const dm = text.match(/(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i)
        if (dm) {
          const day = parseInt(dm[1], 10)
          const month = monthNames[dm[2].toLowerCase()]
          if (!isNaN(day) && month !== undefined) {
            targetDate.setMonth(month, day)
          }
        }
      }
    }

    targetDate.setHours(hour, minute, 0, 0)
    if (!isNaN(targetDate.getTime())) return targetDate.toISOString()
  }
  return null
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const idsParam = url.searchParams.get('ids')
  const dry = url.searchParams.get('dry') !== 'false'
  const debug = url.searchParams.get('debug') === 'true'
  const allowSynthetic = url.searchParams.get('synthetic') === 'true'
  const auditDays = parseInt(url.searchParams.get('audit_days') || '0', 10)
  const auditMode = auditDays > 0 || idsParam === 'auto'

  const supabase = createServiceClient()

  // Fetch recent contacts so we can resolve phone + current stage per id
  const daysToFetch = auditMode ? Math.max(auditDays, 3) : 7
  const contactsById: Record<string, Awaited<ReturnType<typeof getContactsByDays>>[number]> = {}
  try {
    const contacts = await getContactsByDays({ days: daysToFetch })
    for (const c of contacts) {
      if (c.id) contactsById[c.id] = c
    }
  } catch (e) {
    return NextResponse.json({ error: `getContactsByDays failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 })
  }

  // Build ids list: from query, hardcoded known-missing, or auto-discover via DB diff
  let ids: string[]
  if (idsParam && idsParam !== 'auto') {
    ids = idsParam.split(',').map(s => s.trim()).filter(Boolean)
  } else if (auditMode) {
    const allVambeIds = Object.keys(contactsById)
    const { data: existing } = await supabase
      .from('leads')
      .select('vambe_contact_id')
      .in('vambe_contact_id', allVambeIds)
    const existingSet = new Set(((existing || []) as Array<{ vambe_contact_id: string | null }>).map(r => r.vambe_contact_id).filter(Boolean) as string[])
    ids = allVambeIds.filter(id => !existingSet.has(id))
  } else {
    ids = KNOWN_MISSING_IDS
  }

  type ResultRow = {
    contact_id: string
    action: 'created' | 'skipped_exists' | 'skipped_no_email' | 'error'
    nombre?: string | null
    email?: string | null
    telefono?: string | null
    empresa?: string | null
    status?: string
    llamada_at?: string | null
    stage_id?: string | null
    reason?: string
    message_count?: number
    debug?: unknown
  }
  const results: ResultRow[] = []

  for (const contactId of ids) {
    const contact = contactsById[contactId]
    const stageId = contact?.active_ticket_v2?.current_stage_id || contact?.default_stage_id || STAGE_INTERESADO
    const { status, tipo_llamada, mapped } = stageToStatus(stageId)
    const includeUnmapped = url.searchParams.get('include_unmapped') === 'true'
    if (!mapped && !includeUnmapped) {
      results.push({
        contact_id: contactId,
        action: 'skipped_no_email',
        nombre: contact?.name || null,
        telefono: contact?.phone ? (normalizeMexicanPhone(contact.phone) || contact.phone) : null,
        stage_id: stageId,
        status,
        reason: `stage no mapeado (${stageId.slice(0, 8)}) — Lanzamiento/Asistencia/Contactados — usa &include_unmapped=true para forzar`,
      })
      continue
    }

    let messages: Awaited<ReturnType<typeof getMessages>> = []
    try {
      messages = await getMessages(contactId, 50)
    } catch (e) {
      results.push({ contact_id: contactId, action: 'error', reason: `getMessages: ${e instanceof Error ? e.message : String(e)}` })
      continue
    }

    let email: string | null = contact?.email?.toLowerCase()?.trim() || null
    let nombre: string | null = contact?.name?.trim() || null
    let telefono: string | null = contact?.phone ? (normalizeMexicanPhone(contact.phone) || contact.phone) : null

    const inbound = messages.filter(m => m.direction === 'inbound')
    const outbound = messages.filter(m => m.direction === 'outbound')

    if (!email) {
      for (const m of inbound) {
        const emailMatch = (m.message || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/)
        if (emailMatch) { email = emailMatch[0].toLowerCase(); break }
      }
    }
    if (!nombre) {
      for (const m of outbound.slice(0, 10)) {
        const nameMatch = (m.message || '').match(/¡?(Hola|Perfecto|Excelente|Entendido|Mucho gusto|Gracias)[,!]?\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\b/)
        if (nameMatch && nameMatch[2]) { nombre = nameMatch[2].trim(); break }
      }
    }

    // Lookup existing lead by 3 keys: vambe_contact_id, email, phone last10
    type ExistingLead = { id: string; nombre?: string | null; email?: string | null; status?: string; vambe_contact_id?: string | null; vambe_stage_id?: string | null }
    let existing: ExistingLead | null = null
    {
      const r = await supabase.from('leads').select('id, nombre, email, status, vambe_contact_id, vambe_stage_id').eq('vambe_contact_id', contactId).maybeSingle()
      if (r.data) existing = r.data as ExistingLead
    }
    if (!existing && email && !email.endsWith('@chambas.placeholder')) {
      const r = await supabase.from('leads').select('id, nombre, email, status, vambe_contact_id, vambe_stage_id').ilike('email', email).maybeSingle()
      if (r.data) existing = r.data as ExistingLead
    }
    if (!existing && telefono) {
      const last10 = telefono.replace(/\D/g, '').slice(-10)
      const r = await supabase.from('leads').select('id, nombre, email, status, vambe_contact_id, vambe_stage_id').like('telefono', `%${last10}`).maybeSingle()
      if (r.data) existing = r.data as ExistingLead
    }

    if (existing) {
      // Link vambe_contact_id + advance stage if needed (no email/nombre overwrite)
      const updates: Record<string, unknown> = {}
      if (!existing.vambe_contact_id) updates.vambe_contact_id = contactId
      if (existing.vambe_stage_id !== stageId) updates.vambe_stage_id = stageId
      // Don't change status here — backfill flow already handles that. Just link.
      if (Object.keys(updates).length > 0 && !dry) {
        await supabase.from('leads').update(updates).eq('id', existing.id)
      }
      results.push({
        contact_id: contactId,
        action: 'skipped_exists',
        nombre: existing.nombre,
        email: existing.email,
        status: existing.status,
        stage_id: stageId,
        reason: `ya existe (lead.id=${existing.id}, linked_now=${Object.keys(updates).length > 0})`,
      })
      continue
    }

    const llamadaAt = (status === 'llamada_agendada') ? extractDateFromMessages(messages) : null

    const debugPayload = debug ? {
      stage_id: stageId,
      stage_mapped_status: status,
      tipo_llamada,
      contact_meta: contact ? { phone: contact.phone, email: contact.email, name: contact.name, default_stage_id: contact.default_stage_id, active_ticket: contact.active_ticket_v2 } : null,
      inbound_count: inbound.length,
      outbound_count: outbound.length,
      detected_llamada_at: llamadaAt,
    } : undefined

    if (!email && allowSynthetic) {
      const stamp = telefono ? telefono.replace(/\D/g, '') : contactId.slice(0, 8)
      email = `vambe-${stamp}@chambas.placeholder`
    }

    if (!email) {
      results.push({
        contact_id: contactId,
        action: 'skipped_no_email',
        nombre,
        telefono,
        stage_id: stageId,
        status,
        reason: 'sin email — usá &synthetic=true para crear con placeholder',
        message_count: messages.length,
        debug: debugPayload,
      })
      continue
    }

    const empresa = email.endsWith('@chambas.placeholder') ? null : extractCompanyFromEmail(email)

    const insert: Record<string, unknown> = {
      canal_adquisicion: 'Vambe',
      vambe_contact_id: contactId,
      vambe_stage_id: stageId,
      email: email.toLowerCase().trim(),
      status,
      tipo_evento: 'vambe_form',
      monto: 1160,
    }
    if (nombre) insert.nombre = nombre
    if (telefono) insert.telefono = telefono
    if (empresa) insert.empresa = empresa
    if (tipo_llamada) insert.tipo_llamada = tipo_llamada
    if (llamadaAt) insert.llamada_at = llamadaAt
    if (email.endsWith('@chambas.placeholder')) {
      insert.notas = '⚠️ Email placeholder — lead vino sin email en conversación Vambe. Pedir email manualmente.'
    }

    if (dry) {
      results.push({
        contact_id: contactId,
        action: 'created',
        nombre,
        email,
        telefono,
        empresa,
        status,
        llamada_at: llamadaAt,
        stage_id: stageId,
        message_count: messages.length,
        reason: '(dry-run)',
        debug: debugPayload,
      })
      continue
    }

    const { data: newLead, error: insErr } = await supabase
      .from('leads')
      .insert(insert)
      .select('id')
      .maybeSingle()
    if (insErr) {
      results.push({ contact_id: contactId, action: 'error', reason: insErr.message, debug: debugPayload })
      continue
    }
    const newId = (newLead as { id?: string } | null)?.id
    if (newId) {
      await supabase.from('lead_actividad').insert({
        lead_id: newId,
        tipo: 'vambe_bootstrap_created',
        descripcion: `🚀 Lead creado por /admin/bootstrap-missing-leads (stage=${status}${llamadaAt ? `, llamada=${llamadaAt}` : ''})`,
        metadata: { source: 'bootstrap', contact_id: contactId, stage_id: stageId, message_count: messages.length, llamada_at: llamadaAt, synthetic_email: email.endsWith('@chambas.placeholder') },
      })
    }

    results.push({
      contact_id: contactId,
      action: 'created',
      nombre,
      email,
      telefono,
      empresa,
      status,
      llamada_at: llamadaAt,
      stage_id: stageId,
      message_count: messages.length,
    })
  }

  return NextResponse.json({
    dry,
    total: ids.length,
    created: results.filter(r => r.action === 'created').length,
    skipped_exists: results.filter(r => r.action === 'skipped_exists').length,
    skipped_no_email: results.filter(r => r.action === 'skipped_no_email').length,
    errors: results.filter(r => r.action === 'error').length,
    results,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
