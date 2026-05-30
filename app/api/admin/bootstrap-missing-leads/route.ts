import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { getMessages } from '@/lib/vambe'
import { extractCompanyFromEmail, normalizePuesto, normalizeVacante } from '@/lib/vambeNormalize'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/admin/bootstrap-missing-leads?ids=<csv>&dry=true|false
 *
 * ONE-SHOT endpoint para sembrar leads que se quedaron afuera del CRM
 * porque no tienen form parseable (Vambe los inicia outbound).
 *
 * Scope-limited: SÓLO crea leads (no update / no delete), sólo si los IDs
 * no existen ya. Sin secret — endpoint efímero que se borra después.
 */
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
  const ids = idsParam ? idsParam.split(',').map(s => s.trim()).filter(Boolean) : KNOWN_MISSING_IDS

  const supabase = createServiceClient()

  const results: Array<{
    contact_id: string
    action: 'created' | 'skipped_exists' | 'skipped_no_email' | 'error'
    nombre?: string | null
    email?: string | null
    telefono?: string | null
    empresa?: string | null
    reason?: string
    message_count?: number
  }> = []

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
        nombre: existing.nombre,
        email: existing.email,
        reason: `ya existe (lead.id=${existing.id})`,
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

    for (const m of inbound) {
      if (!telefono && m.from_number) {
        telefono = normalizeMexicanPhone(m.from_number) || m.from_number
      }
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

    if (!email) {
      results.push({
        contact_id: contactId,
        action: 'skipped_no_email',
        nombre,
        telefono,
        reason: 'sin email en mensajes',
        message_count: messages.length,
      })
      continue
    }

    const empresa = extractCompanyFromEmail(email)

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
      })
      continue
    }

    const newId = (newLead as { id?: string } | null)?.id
    if (newId) {
      await supabase.from('lead_actividad').insert({
        lead_id: newId,
        tipo: 'vambe_bootstrap_created',
        descripcion: '🚀 Lead creado por /admin/bootstrap-missing-leads (sin form, datos extraídos de conversación)',
        metadata: { source: 'bootstrap', contact_id: contactId, message_count: messages.length },
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
