import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { getMessages, getContactsByDays, parseFormMessage } from '@/lib/vambe'
import { extractCompanyFromEmail, normalizePuesto, normalizeVacante, buildNotasFromForm } from '@/lib/vambeNormalize'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/admin/bootstrap-missing-leads?ids=<csv>&audit_days=N&dry=true|false&synthetic=true|false
 *
 * Endpoint diagnóstico / one-shot para promover leads de Vambe al CRM sin
 * depender del webhook (útil cuando un evento se perdió o falló).
 *
 * - SOLO crea / linkea — nunca borra ni pisa datos existentes
 * - Resuelve stage desde Vambe API
 * - Mapea TODOS los stages activos (Lanzamiento, Interesado, Llamadas, etc.) a status del CRM
 * - Parsea llamada_at desde mensajes
 * - Lookup por vambe_contact_id + email + phone last10 (no duplica)
 */

const STAGE_MAP: Record<string, Lead['status']> = {
  '96c42cda-2828-45db-973c-3bc63a8141fd': 'nuevo',              // Interesado
  '05b9af0a-9bcb-4faf-a114-bdd47517a97a': 'nuevo',              // Lanzamiento
  'dd41a38e-3b22-42f3-a6d3-b130b9ca449f': 'nuevo',              // Asistencia Humana
  '5847352c-f983-4e8b-b635-b19797d031a8': 'nuevo',              // Contactados WhatsApp
  '971fe009-72d1-44fb-932b-aa94adcec4db': 'llamada_agendada',
  '2fc44415-960f-4dbd-b65b-1500636fc41a': 'llamada_agendada',
  'cd0ab574-c844-4346-bea3-4ddd084fcb92': 'llamada_agendada',
  'c86a7911-ef9d-4f6d-8c90-3e9a9a4d6b50': 'convertido',
  '9a43e657-b5cc-4baf-a503-1e0b37b9b366': 'descartado',
}
const TIPO_LLAMADA: Record<string, 'demo' | 'comercial'> = {
  '971fe009-72d1-44fb-932b-aa94adcec4db': 'demo',
  '2fc44415-960f-4dbd-b65b-1500636fc41a': 'demo',
  'cd0ab574-c844-4346-bea3-4ddd084fcb92': 'comercial',
}

function extractDateFromMessages(messages: Array<{ message: string; created_at: string }>): string | null {
  for (const msg of messages.slice(0, 15)) {
    const text = msg.message || ''
    if (!text) continue
    const isAgenda = /(agendad[ao]|confirmad[ao]|cita|llamada|reunion|reunion[ée])\b/i.test(text)
      || /\b(perfecto|excelente|listo)\b.*\b(am|pm)\b/i.test(text)
    if (!isAgenda) continue
    const hm = text.match(/(\b\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    if (!hm) continue
    let hour = parseInt(hm[1], 10)
    const minute = parseInt(hm[2] || '0', 10)
    const ampm = (hm[3] || '').toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    const target = new Date(msg.created_at)
    if (/\bma[nñ]ana\b/i.test(text)) target.setDate(target.getDate() + 1)
    else if (!/\bhoy\b/i.test(text)) {
      const dayNames: Record<string, number> = { domingo:0, lunes:1, martes:2, miercoles:3, miércoles:3, jueves:4, viernes:5, sabado:6, sábado:6 }
      for (const [n, dow] of Object.entries(dayNames)) {
        if (new RegExp(`\\b${n}\\b`, 'i').test(text)) {
          const diff = (dow - target.getDay() + 7) % 7 || 7
          target.setDate(target.getDate() + diff)
          break
        }
      }
    }
    target.setHours(hour, minute, 0, 0)
    if (!isNaN(target.getTime())) return target.toISOString()
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
  const daysToFetch = auditMode ? Math.max(auditDays, 3) : 7

  const contactsById: Record<string, Awaited<ReturnType<typeof getContactsByDays>>[number]> = {}
  try {
    const contacts = await getContactsByDays({ days: daysToFetch })
    for (const c of contacts) if (c.id) contactsById[c.id] = c
  } catch (e) {
    return NextResponse.json({ error: `getContactsByDays: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 })
  }

  let ids: string[]
  if (idsParam && idsParam !== 'auto') {
    ids = idsParam.split(',').map(s => s.trim()).filter(Boolean)
  } else if (auditMode) {
    const allIds = Object.keys(contactsById)
    const { data: existing } = await supabase.from('leads').select('vambe_contact_id').in('vambe_contact_id', allIds)
    const existingSet = new Set(((existing || []) as Array<{ vambe_contact_id: string | null }>).map(r => r.vambe_contact_id).filter(Boolean) as string[])
    ids = allIds.filter(id => !existingSet.has(id))
  } else {
    ids = []
  }

  type ResultRow = {
    contact_id: string
    action: 'created' | 'linked' | 'skipped_exists' | 'skipped_no_email' | 'skipped_unknown_stage' | 'error'
    nombre?: string | null
    email?: string | null
    telefono?: string | null
    empresa?: string | null
    status?: string
    stage_id?: string | null
    llamada_at?: string | null
    reason?: string
    debug?: unknown
  }
  const results: ResultRow[] = []

  for (const contactId of ids) {
    const contact = contactsById[contactId]
    const stageId = contact?.active_ticket_v2?.current_stage_id || contact?.default_stage_id || null
    const status = stageId ? STAGE_MAP[stageId] : undefined
    const tipoLlamada = stageId ? TIPO_LLAMADA[stageId] : undefined

    if (!status) {
      results.push({
        contact_id: contactId,
        action: 'skipped_unknown_stage',
        nombre: contact?.name || null,
        telefono: contact?.phone ? (normalizeMexicanPhone(contact.phone) || contact.phone) : null,
        stage_id: stageId,
        reason: `stage ${stageId?.slice(0,8) || 'null'} no mapeado`,
      })
      continue
    }

    let messages: Awaited<ReturnType<typeof getMessages>> = []
    try { messages = await getMessages(contactId, 50) } catch (e) {
      results.push({ contact_id: contactId, action: 'error', reason: `getMessages: ${e instanceof Error ? e.message : String(e)}` })
      continue
    }

    // 1) Try form parse from any message
    let form = null as ReturnType<typeof parseFormMessage>
    for (const m of messages) {
      const p = parseFormMessage(m.message || '')
      if (p) { form = p; break }
    }

    let email: string | null = form?.email?.toLowerCase()?.trim() || contact?.email?.toLowerCase()?.trim() || null
    let nombre: string | null = form?.nombre?.trim() || contact?.name?.trim() || null
    let telefono: string | null = form?.telefono ? (normalizeMexicanPhone(form.telefono) || form.telefono) : (contact?.phone ? (normalizeMexicanPhone(contact.phone) || contact.phone) : null)
    let vacante: string | null = form?.vacante ? (normalizeVacante(form.vacante) || form.vacante) : null
    let puesto: string | null = form?.rol ? (normalizePuesto(form.rol) || form.rol) : null
    const presupuesto = form?.presupuesto || null

    // Fallback: extract email from inbound, name from outbound
    const inbound = messages.filter(m => m.direction === 'inbound')
    const outbound = messages.filter(m => m.direction === 'outbound')
    if (!email) {
      for (const m of inbound) {
        const em = (m.message || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/)
        if (em) { email = em[0].toLowerCase(); break }
      }
    }
    if (!nombre) {
      for (const m of outbound.slice(0, 10)) {
        const nm = (m.message || '').match(/¡?(Hola|Perfecto|Excelente|Entendido|Mucho gusto|Gracias)[,!]?\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\b/)
        if (nm && nm[2]) { nombre = nm[2].trim(); break }
      }
    }

    // Lookup existing by vambe_contact_id / email / phone last10
    type EL = { id: string; nombre?: string | null; email?: string | null; status?: string; vambe_contact_id?: string | null; vambe_stage_id?: string | null }
    let existing: EL | null = null
    let foundBy: string | null = null
    {
      const r = await supabase.from('leads').select('id, nombre, email, status, vambe_contact_id, vambe_stage_id').eq('vambe_contact_id', contactId).maybeSingle()
      if (r.data) { existing = r.data as EL; foundBy = 'vambe_id' }
    }
    if (!existing && email && !email.endsWith('@chambas.placeholder')) {
      const r = await supabase.from('leads').select('id, nombre, email, status, vambe_contact_id, vambe_stage_id').ilike('email', email).limit(1)
      if (r.data && r.data.length > 0) { existing = r.data[0] as EL; foundBy = 'email' }
    }
    if (!existing && telefono) {
      const last10 = telefono.replace(/\D/g, '').slice(-10)
      const r = await supabase.from('leads').select('id, nombre, email, status, vambe_contact_id, vambe_stage_id').like('telefono', `%${last10}`).limit(1)
      if (r.data && r.data.length > 0) { existing = r.data[0] as EL; foundBy = 'phone' }
    }

    if (existing) {
      const updates: Record<string, unknown> = {}
      if (!existing.vambe_contact_id) updates.vambe_contact_id = contactId
      if (existing.vambe_stage_id !== stageId) updates.vambe_stage_id = stageId
      if (Object.keys(updates).length > 0 && !dry) {
        await supabase.from('leads').update(updates).eq('id', existing.id)
      }
      results.push({
        contact_id: contactId,
        action: Object.keys(updates).length > 0 ? 'linked' : 'skipped_exists',
        nombre: existing.nombre,
        email: existing.email,
        status: existing.status,
        stage_id: stageId,
        reason: `lead.id=${existing.id}, found_by=${foundBy}, linked=${Object.keys(updates).length > 0}`,
      })
      continue
    }

    const llamadaAt = status === 'llamada_agendada' ? extractDateFromMessages(messages.map(m => ({ message: m.message || '', created_at: m.created_at }))) : null

    if (!email && allowSynthetic) {
      const stamp = telefono ? telefono.replace(/\D/g, '') : contactId.slice(0, 8)
      email = `vambe-${stamp}@chambas.placeholder`
    }

    if (!email) {
      results.push({
        contact_id: contactId,
        action: 'skipped_no_email',
        nombre, telefono, stage_id: stageId, status,
        reason: 'sin email — usá &synthetic=true para crear con placeholder',
        debug: debug ? { has_form: !!form, inbound: inbound.length, outbound: outbound.length } : undefined,
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
    if (vacante) insert.vacante = vacante
    if (puesto) insert.puesto = puesto
    if (presupuesto) insert.presupuesto = presupuesto
    if (tipoLlamada) insert.tipo_llamada = tipoLlamada
    if (llamadaAt) insert.llamada_at = llamadaAt
    if (email.endsWith('@chambas.placeholder')) insert.notas = '⚠️ Email placeholder — pedir email manualmente.'
    if (form) insert.notas = (insert.notas ? `${insert.notas}\n\n` : '') + (buildNotasFromForm(form) || '')

    if (dry) {
      results.push({ contact_id: contactId, action: 'created', nombre, email, telefono, empresa, status, llamada_at: llamadaAt, stage_id: stageId, reason: '(dry-run)' })
      continue
    }

    const { data: newLead, error: insErr } = await supabase.from('leads').insert(insert).select('id').maybeSingle()
    if (insErr) {
      results.push({ contact_id: contactId, action: 'error', reason: insErr.message })
      continue
    }
    const newId = (newLead as { id?: string } | null)?.id
    if (newId) {
      await supabase.from('lead_actividad').insert({
        lead_id: newId,
        tipo: 'vambe_bootstrap_created',
        descripcion: `🚀 Lead creado por bootstrap (stage=${status}, llamada=${llamadaAt || 'n/a'})`,
        metadata: { source: 'bootstrap', contact_id: contactId, stage_id: stageId, llamada_at: llamadaAt, synthetic_email: email.endsWith('@chambas.placeholder') },
      })
    }
    results.push({ contact_id: contactId, action: 'created', nombre, email, telefono, empresa, status, llamada_at: llamadaAt, stage_id: stageId })
  }

  return NextResponse.json({
    dry,
    total: ids.length,
    created: results.filter(r => r.action === 'created').length,
    linked: results.filter(r => r.action === 'linked').length,
    skipped_exists: results.filter(r => r.action === 'skipped_exists').length,
    skipped_no_email: results.filter(r => r.action === 'skipped_no_email').length,
    skipped_unknown_stage: results.filter(r => r.action === 'skipped_unknown_stage').length,
    errors: results.filter(r => r.action === 'error').length,
    results,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
