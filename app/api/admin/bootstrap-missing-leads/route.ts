import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { getMessages } from '@/lib/vambe'
import { extractCompanyFromEmail, normalizePuesto, normalizeVacante } from '@/lib/vambeNormalize'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const KNOWN_MISSING_IDS = [
  'f3373f02-bec7-4cb9-a49a-9dbd1352c0f1',
  '6ea94e31-f6ed-407a-b38c-7638e77c0045',
  'ab46c4e5-f6e0-4b76-8b57-825b08b6f46d',
]

const STAGE_INTERESADO = '96c42cda-2828-45db-973c-3bc63a8141fd'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const idsParam = url.searchParams.get('ids')
  const dry = url.searchParams.get('dry') !== 'false'
  const debug = url.searchParams.get('debug') === 'true'
  const allowSynthetic = url.searchParams.get('synthetic') === 'true'
  const ids = idsParam ? idsParam.split(',').map(s => s.trim()).filter(Boolean) : KNOWN_MISSING_IDS

  const supabase = createServiceClient()

  type ResultRow = {
    contact_id: string
    action: 'created' | 'skipped_exists' | 'skipped_no_email' | 'error'
    nombre?: string | null
    email?: string | null
    telefono?: string | null
    empresa?: string | null
    reason?: string
    message_count?: number
    debug?: unknown
  }
  const results: ResultRow[] = []

  for (const contactId of ids) {
    const { data: existing } = await supabase
      .from('leads')
      .select('id, nombre, email')
      .eq('vambe_contact_id', contactId)
      .maybeSingle()

    if (existing) {
      results.push({
        contact_id: contactId,
        action: 'skipped_exists',
        nombre: (existing as { nombre?: string | null }).nombre,
        email: (existing as { email?: string | null }).email,
        reason: `ya existe (lead.id=${(existing as { id: string }).id})`,
      })
      continue
    }

    let messages: Awaited<ReturnType<typeof getMessages>> = []
    try {
      messages = await getMessages(contactId, 50)
    } catch (e) {
      results.push({
        contact_id: contactId,
        action: 'error',
        reason: `Vambe getMessages failed: ${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }

    let email: string | null = null
    let nombre: string | null = null
    let telefono: string | null = null
    let vacante: string | null = null

    const inbound = messages.filter(m => m.direction === 'inbound')
    const outbound = messages.filter(m => m.direction === 'outbound')

    // Phone: try all phone-like fields on all messages (inbound, outbound to_number)
    for (const m of messages) {
      if (telefono) break
      const candidates = [
        (m as unknown as Record<string, unknown>).from_number,
        (m as unknown as Record<string, unknown>).to_number,
        (m as unknown as Record<string, unknown>).phone,
        (m as unknown as Record<string, unknown>).contact_phone,
      ]
      for (const c of candidates) {
        if (typeof c === 'string' && c.replace(/\D/g, '').length >= 10) {
          // skip Vambe channel phone (the one Vambe uses to send) — that's NOT the customer
          const digits = c.replace(/\D/g, '')
          if (process.env.VAMBE_CHANNEL_PHONE && digits === process.env.VAMBE_CHANNEL_PHONE.replace(/\D/g, '')) {
            continue
          }
          telefono = normalizeMexicanPhone(c) || c
          break
        }
      }
    }

    for (const m of inbound) {
      if (!email) {
        const emailMatch = (m.message || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/)
        if (emailMatch) email = emailMatch[0].toLowerCase()
      }
      if (!vacante) {
        const vacMatch = (m.message || '').match(/(?:vacante|puesto|busco|necesito|requiero)\s+(?:de\s+|para\s+)?([a-zA-ZáéíóúñÁÉÍÓÚÑ\s]{4,60})/i)
        if (vacMatch && vacMatch[1]) vacante = vacMatch[1].trim().slice(0, 80)
      }
    }

    for (const m of outbound.slice(0, 10)) {
      if (nombre) break
      const nameMatch = (m.message || '').match(/¡?(Hola|Perfecto|Excelente|Entendido|Mucho gusto|Gracias)[,!]?\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\b/)
      if (nameMatch && nameMatch[2]) {
        nombre = nameMatch[2].trim()
      }
    }

    const debugPayload = debug ? {
      inbound_count: inbound.length,
      outbound_count: outbound.length,
      first_inbound: inbound[0],
      first_outbound: outbound[0],
      message_sample: messages.slice(0, 5).map(m => ({ d: m.direction, t: (m.message || '').slice(0, 200), fn: (m as Record<string, unknown>).from_number, tn: (m as Record<string, unknown>).to_number })),
    } : undefined

    // If no email but synthetic mode enabled, use phone or contact_id as fallback
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
        reason: 'sin email en mensajes (usa &synthetic=true para crear con placeholder)',
        message_count: messages.length,
        debug: debugPayload,
      })
      continue
    }

    const empresa = email.endsWith('@chambas.placeholder') ? null : extractCompanyFromEmail(email)

    const insert: Record<string, unknown> = {
      canal_adquisicion: 'Vambe',
      vambe_contact_id: contactId,
      vambe_stage_id: STAGE_INTERESADO,
      email: email.toLowerCase().trim(),
      status: 'nuevo',
      tipo_evento: 'vambe_form',
      monto: 1160,
    }
    if (nombre) insert.nombre = nombre
    if (telefono) insert.telefono = telefono
    if (empresa) insert.empresa = empresa
    if (vacante) insert.vacante = normalizeVacante(vacante) || vacante
    if (email.endsWith('@chambas.placeholder')) {
      insert.notas = `⚠️ Email placeholder — lead vino sin email en conversación Vambe. Pedir email manualmente.`
    }

    if (dry) {
      results.push({
        contact_id: contactId,
        action: 'created',
        nombre,
        email,
        telefono,
        empresa,
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
      results.push({
        contact_id: contactId,
        action: 'error',
        reason: insErr.message,
        debug: debugPayload,
      })
      continue
    }

    const newId = (newLead as { id?: string } | null)?.id
    if (newId) {
      await supabase.from('lead_actividad').insert({
        lead_id: newId,
        tipo: 'vambe_bootstrap_created',
        descripcion: '🚀 Lead creado por /admin/bootstrap-missing-leads (sin form, datos extraídos de conversación)',
        metadata: { source: 'bootstrap', contact_id: contactId, message_count: messages.length, synthetic_email: email.endsWith('@chambas.placeholder') },
      })
    }

    results.push({
      contact_id: contactId,
      action: 'created',
      nombre,
      email,
      telefono,
      empresa,
      message_count: messages.length,
    })
  }

  const summary = {
    dry,
    total: ids.length,
    created: results.filter(r => r.action === 'created').length,
    skipped_exists: results.filter(r => r.action === 'skipped_exists').length,
    skipped_no_email: results.filter(r => r.action === 'skipped_no_email').length,
    errors: results.filter(r => r.action === 'error').length,
    results,
  }

  return NextResponse.json(summary, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
