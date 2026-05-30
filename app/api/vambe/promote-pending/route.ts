import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import type { FormFields } from '@/lib/vambe'
import { extractCompanyFromEmail, normalizePuesto, normalizeVacante, buildNotasFromForm } from '@/lib/vambeNormalize'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * GET /api/vambe/promote-pending?dry=true|false&secret=...
 *
 * Promueve TODOS los leads en `vambe_pending_leads` al CRM como `status='nuevo'`,
 * sin esperar a que Vambe dispare un stage.changed.
 *
 * Útil cuando:
 *  - Vambe no tiene registrado el webhook stage.changed
 *  - Stage.changed se perdió (timeout, retry de Vambe)
 *  - Quieren forzar visibilidad en CRM antes de que la AI califique
 *
 * Cada lead promovido se borra de `vambe_pending_leads`.
 * Idempotente: si volvés a correrlo, no hace nada (la tabla está vacía).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!process.env.VAMBE_WEBHOOK_SECRET || secret !== process.env.VAMBE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const dry = url.searchParams.get('dry') !== 'false'

  const supabase = createServiceClient()

  // Stage UUIDs por si necesitamos atribución
  const STAGE_INTERESADO = '96c42cda-2828-45db-973c-3bc63a8141fd'

  const { data: pending, error } = await supabase
    .from('vambe_pending_leads')
    .select('vambe_contact_id, form_data, raw_event, received_at')
    .order('received_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (pending || []) as Array<{
    vambe_contact_id: string
    form_data: FormFields
    raw_event: Record<string, unknown> | null
    received_at: string
  }>

  const stats = {
    dry,
    total_pending: rows.length,
    created: 0,
    updated_existing: 0,
    skipped_no_email: 0,
    errors: [] as Array<{ vambe_contact_id: string; reason: string }>,
    samples: [] as Array<{ vambe_contact_id: string; nombre: string | null; email: string | null; action: string }>,
  }

  for (const row of rows) {
    const aiContactId = row.vambe_contact_id
    const form = row.form_data || {}

    if (!form.email) {
      stats.skipped_no_email++
      stats.errors.push({ vambe_contact_id: aiContactId, reason: 'sin email en form' })
      continue
    }

    // Buscar lead existente (email > vambe_contact_id > teléfono)
    let lead: Lead | null = null
    {
      const { data } = await supabase.from('leads').select('*').ilike('email', form.email).maybeSingle()
      if (data) lead = data as Lead
    }
    if (!lead && aiContactId) {
      const { data } = await supabase.from('leads').select('*').eq('vambe_contact_id', aiContactId).maybeSingle()
      if (data) lead = data as Lead
    }
    if (!lead && form.telefono) {
      const last10 = form.telefono.replace(/\D/g, '').slice(-10)
      const { data } = await supabase.from('leads').select('*').like('telefono', `%${last10}`).maybeSingle()
      if (data) lead = data as Lead
    }

    // Construir campos normalizados
    const fields: Record<string, unknown> = {
      canal_adquisicion: 'Vambe',
      vambe_contact_id: aiContactId,
      vambe_stage_id: STAGE_INTERESADO,
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

    if (lead) {
      // Update solo campos vacíos + sobreescribir vacante/puesto/notas (normalizados)
      const NORMALIZED_FIELDS = new Set(['vacante', 'puesto', 'notas', 'telefono'])
      const updates: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(fields)) {
        const existing = (lead as unknown as Record<string, unknown>)[k]
        if (NORMALIZED_FIELDS.has(k) && v) {
          if (v !== existing) updates[k] = v
        } else if (v && (existing === null || existing === undefined || existing === '')) {
          updates[k] = v
        }
      }
      if (!lead.vambe_contact_id) updates.vambe_contact_id = aiContactId
      if (!lead.canal_adquisicion) updates.canal_adquisicion = 'Vambe'

      if (Object.keys(updates).length > 0 && !dry) {
        await supabase.from('leads').update(updates).eq('id', lead.id)
      }
      stats.updated_existing++
      if (stats.samples.length < 25) {
        stats.samples.push({ vambe_contact_id: aiContactId, nombre: lead.nombre, email: lead.email, action: 'updated' })
      }
    } else {
      // Crear nuevo lead con status='nuevo'
      const insert: Record<string, unknown> = {
        ...fields,
        email: (form.email || '').toLowerCase().trim(),
        status: 'nuevo',
        tipo_evento: 'vambe_form',
        monto: 1160,
      }
      for (const k of Object.keys(insert)) {
        if (insert[k] === undefined) delete insert[k]
      }
      if (!dry) {
        const { data, error: insErr } = await supabase.from('leads').insert(insert).select('id').maybeSingle()
        if (insErr) {
          stats.errors.push({ vambe_contact_id: aiContactId, reason: insErr.message })
          continue
        }
        const newId = (data as { id?: string } | null)?.id
        if (newId) {
          await supabase.from('lead_actividad').insert({
            lead_id: newId,
            tipo: 'vambe_lead_promoted',
            descripcion: '🚀 Lead promovido por endpoint /promote-pending (bypass stage.changed)',
            metadata: { source: 'promote-pending', form, raw_event: row.raw_event },
          })
        }
      }
      stats.created++
      if (stats.samples.length < 25) {
        stats.samples.push({
          vambe_contact_id: aiContactId,
          nombre: form.nombre || null,
          email: form.email || null,
          action: 'created',
        })
      }
    }

    // Borrar del pending después de procesar
    if (!dry) {
      await supabase.from('vambe_pending_leads').delete().eq('vambe_contact_id', aiContactId)
    }
  }

  return NextResponse.json(stats)
}
