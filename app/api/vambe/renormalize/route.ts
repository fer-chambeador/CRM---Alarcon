import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { extractCompanyFromEmail, normalizePuesto, normalizeVacante, buildNotasFromForm } from '@/lib/vambeNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * GET /api/vambe/renormalize?dry=true|false&secret=...&canal=Vambe|all
 *
 * Re-normaliza data YA presente en el CRM sin tocar Vambe — solo lee/escribe en
 * Supabase. Mucho más rápido que el backfill completo cuando solo querés aplicar
 * los normalizadores actualizados a los leads existentes.
 *
 * Acciones (idempotentes):
 *  - vacante → normalizeVacante (Seguridad, Limpieza, Mesero, Cocinero, etc)
 *  - puesto → normalizePuesto (Reclutador, Dueño, Gerente, Otro)
 *  - empresa ← extractCompanyFromEmail si está vacío y el email es corporativo
 *  - notas ← buildNotasFromForm (solo para leads Vambe que tengan form guardado en activity)
 *
 * Por default procesa TODOS los leads (Slack + Vambe) para unificar categorías.
 * Pasá ?canal=Vambe para limitarlo solo a leads de Vambe.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!process.env.VAMBE_WEBHOOK_SECRET || secret !== process.env.VAMBE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const dry = url.searchParams.get('dry') !== 'false'
  const canalFilter = url.searchParams.get('canal')   // ej "Vambe" para limitar

  const supabase = createServiceClient()
  let query = supabase
    .from('leads')
    .select('id, email, empresa, puesto, vacante, notas, canal_adquisicion, tipo_evento')
  if (canalFilter) query = query.eq('canal_adquisicion', canalFilter)
  const { data: leads, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (leads || []) as Pick<Lead, 'id' | 'email' | 'empresa' | 'puesto' | 'vacante' | 'notas' | 'canal_adquisicion' | 'tipo_evento'>[]

  // Cargar el form de cada lead desde lead_actividad (backfill_created o form_received)
  const ids = rows.map(r => r.id)
  const { data: activityRows } = await supabase
    .from('lead_actividad')
    .select('lead_id, metadata, tipo')
    .in('lead_id', ids)
    .in('tipo', ['vambe_backfill_created', 'vambe_form_received'])
  const formByLead = new Map<string, Record<string, unknown> | null>()
  for (const a of activityRows || []) {
    const meta = (a.metadata || {}) as Record<string, unknown>
    const form = (meta.form || null) as Record<string, unknown> | null
    if (form && !formByLead.has(a.lead_id)) formByLead.set(a.lead_id, form)
  }

  const stats = {
    dry,
    total: rows.length,
    vacante_changed: 0,
    puesto_changed: 0,
    empresa_added: 0,
    notas_added: 0,
    unchanged: 0,
    write_ok: 0,
    write_errors: [] as Array<{ id: string; error: string }>,
    samples: [] as Array<{ id: string; email: string | null; before: Record<string, string | null>; after: Record<string, string | null> }>,
  }

  // Procesar SECUENCIAL — concurrent updates con Promise.all parecía perder
  // writes (silenciosamente). Mejor seguro que rápido para una operación one-shot.
  for (const lead of rows) {
    const updates: Record<string, unknown> = {}
    const before: Record<string, string | null> = {}
    const after: Record<string, string | null> = {}

    // vacante
    if (lead.vacante) {
      const norm = normalizeVacante(lead.vacante)
      if (norm && norm !== lead.vacante) {
        updates.vacante = norm
        before.vacante = lead.vacante
        after.vacante = norm
        stats.vacante_changed++
      }
    }

    // puesto
    if (lead.puesto) {
      const norm = normalizePuesto(lead.puesto)
      if (norm && norm !== lead.puesto) {
        updates.puesto = norm
        before.puesto = lead.puesto
        after.puesto = norm
        stats.puesto_changed++
      }
    }

    // empresa desde email corporativo si está vacía
    if (!lead.empresa) {
      const company = extractCompanyFromEmail(lead.email)
      if (company) {
        updates.empresa = company
        before.empresa = null
        after.empresa = company
        stats.empresa_added++
      }
    }

    // notas desde el form guardado en lead_actividad
    const form = formByLead.get(lead.id) as {
      vacantes_por_mes?: string
      inbox_url?: string
      rol?: string
    } | undefined
    if (form) {
      const newNotas = buildNotasFromForm(form)
      if (newNotas && (!lead.notas || !lead.notas.includes('Vacantes/mes:'))) {
        updates.notas = newNotas
        before.notas = lead.notas || null
        after.notas = newNotas
        stats.notas_added++
      }
    }

    if (Object.keys(updates).length === 0) {
      stats.unchanged++
      continue
    }

    if (stats.samples.length < 15) {
      stats.samples.push({ id: lead.id, email: lead.email, before, after })
    }

    if (!dry) {
      const { error: updateError } = await supabase.from('leads').update(updates).eq('id', lead.id)
      if (updateError) {
        stats.write_errors.push({ id: lead.id, error: updateError.message })
      } else {
        stats.write_ok++
      }
    }
  }

  return NextResponse.json(stats)
}
