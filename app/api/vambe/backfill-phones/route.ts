import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/vambe/backfill-phones?dry=true|false
 *
 * Backfill de teléfonos para leads de Vambe que entraron al CRM con
 * `telefono = NULL`. Causa raíz (bug fixeado 15-jun-2026):
 *   - El form de Vambe cambió la key a "Phone number:" → norm() = "phonenumber"
 *   - parseFormMessage solo reconocía 'phone'/'telefono'/'celular'/'whatsapp'
 *   - El fallback extractContactPhone tampoco miraba en `ai_contact.phone`
 *
 * Este endpoint busca esos leads y extrae el teléfono del metadata de
 * sus actividades vambe_stage_change / vambe_message / ticket.updated,
 * que SIEMPRE traen `ai_contact.phone` en el payload de Vambe.
 *
 * Devuelve preview en dry, o aplica updates con dry=false.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const dry = url.searchParams.get('dry') !== 'false'

  const supabase = createServiceClient()

  // 1. Leads de Vambe sin teléfono
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, email, nombre, telefono, canal_adquisicion, vambe_contact_id')
    .ilike('canal_adquisicion', 'vambe')
    .or('telefono.is.null,telefono.eq.')
    .limit(500)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const targets = (leads || []) as Array<{
    id: string; email: string; nombre: string | null;
    telefono: string | null; canal_adquisicion: string | null;
    vambe_contact_id: string | null;
  }>

  const results = {
    dry,
    total: targets.length,
    fixed: [] as Array<{ id: string; email: string; phone: string; source: string }>,
    no_phone_found: [] as Array<{ id: string; email: string }>,
    write_errors: [] as Array<{ id: string; reason: string }>,
  }

  for (const lead of targets) {
    // Buscar última actividad con metadata que tenga ai_contact.phone
    const { data: acts } = await supabase
      .from('lead_actividad')
      .select('tipo, metadata')
      .eq('lead_id', lead.id)
      .in('tipo', ['vambe_stage_change', 'vambe_message', 'ticket.created', 'ticket.updated', 'vambe_lead_promoted'])
      .order('created_at', { ascending: false })
      .limit(20)

    let foundPhone: string | null = null
    let source = ''

    for (const a of (acts || []) as Array<{ tipo: string; metadata: Record<string, unknown> | null }>) {
      const meta = a.metadata || {}
      // Path 1: metadata.ai_contact.phone (stage.changed, ticket.updated)
      const aiContact = meta.ai_contact as Record<string, unknown> | undefined
      const p1 = aiContact?.phone || aiContact?.phoneNumber || aiContact?.platform_contact_username
      if (typeof p1 === 'string' && p1.length >= 10) {
        foundPhone = p1
        source = `${a.tipo}.ai_contact.phone`
        break
      }
      // Path 2: metadata.raw.fromNumber / toNumber (vambe_message)
      const raw = meta.raw as Record<string, unknown> | undefined
      const p2 = raw?.fromNumber || raw?.toNumber || raw?.from_number || raw?.to_number
      if (typeof p2 === 'string' && p2.length >= 10) {
        // Skip si es nuestro channel
        const channelPhone = (process.env.VAMBE_CHANNEL_PHONE || '').replace(/[+\s\-()]/g, '')
        const digits = p2.replace(/[+\s\-()]/g, '')
        if (channelPhone && digits.slice(-10) === channelPhone.slice(-10)) continue
        foundPhone = p2
        source = `${a.tipo}.raw.${raw?.fromNumber ? 'fromNumber' : 'toNumber'}`
        break
      }
    }

    if (!foundPhone) {
      results.no_phone_found.push({ id: lead.id, email: lead.email })
      continue
    }

    const normalized = normalizeMexicanPhone(foundPhone) || foundPhone
    results.fixed.push({ id: lead.id, email: lead.email, phone: normalized, source })

    if (!dry) {
      const { error: upErr } = await supabase
        .from('leads')
        .update({ telefono: normalized })
        .eq('id', lead.id)
      if (upErr) results.write_errors.push({ id: lead.id, reason: upErr.message })
    }
  }

  return NextResponse.json(results)
}
