import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { extractCompanyFromEmail, normalizePuesto, normalizeVacante } from '@/lib/vambeNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * GET /api/vambe/renormalize?dry=true|false&secret=...
 *
 * Re-normaliza data YA presente en el CRM sin tocar Vambe — solo lee/escribe en
 * Supabase. Mucho más rápido que el backfill completo cuando solo querés aplicar
 * los normalizadores actualizados a los leads existentes.
 *
 * Acciones:
 *  - vacante → normalizeVacante (Seguridad, Limpieza, etc)
 *  - puesto → normalizePuesto (Reclutador/RH, Dueno, Gerente, Otro)
 *  - empresa ← extractCompanyFromEmail si está vacío y el email es corporativo
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!process.env.VAMBE_WEBHOOK_SECRET || secret !== process.env.VAMBE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const dry = url.searchParams.get('dry') !== 'false'

  const supabase = createServiceClient()
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, email, empresa, puesto, vacante, canal_adquisicion, tipo_evento')
    .eq('canal_adquisicion', 'Vambe')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (leads || []) as Pick<Lead, 'id' | 'email' | 'empresa' | 'puesto' | 'vacante' | 'canal_adquisicion' | 'tipo_evento'>[]

  const stats = {
    dry,
    total: rows.length,
    vacante_changed: 0,
    puesto_changed: 0,
    empresa_added: 0,
    unchanged: 0,
    samples: [] as Array<{ id: string; email: string | null; before: Record<string, string | null>; after: Record<string, string | null> }>,
  }

  // Procesar en paralelo
  await Promise.all(rows.map(async (lead) => {
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

    if (Object.keys(updates).length === 0) {
      stats.unchanged++
      return
    }

    if (stats.samples.length < 15) {
      stats.samples.push({ id: lead.id, email: lead.email, before, after })
    }

    if (!dry) {
      await supabase.from('leads').update(updates).eq('id', lead.id)
    }
  }))

  return NextResponse.json(stats)
}
