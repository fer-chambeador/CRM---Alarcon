import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/vambe/normalize-phones?dry=true|false&secret=...
 *
 * Normaliza el formato de teléfonos en toda la tabla `leads`:
 *  - Quita espacios, paréntesis, guiones
 *  - Si tiene < 11 dígitos y no empieza con +, asume México y le pone +52
 *  - Si tiene 12 dígitos (52 + 10), le pone el + adelante
 *  - Output consistente: +52XXXXXXXXXX (12 chars incluyendo el +)
 *
 * Esto previene el bug de "no encuentro el lead por teléfono" cuando
 * Vambe manda con 521 y CRM guarda con 10 dígitos.
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
    .select('id, telefono')
    .not('telefono', 'is', null)
    .neq('telefono', '')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (leads || []) as Array<{ id: string; telefono: string }>

  const stats = {
    dry,
    total: rows.length,
    changed: 0,
    unchanged: 0,
    invalid: 0,
    write_ok: 0,
    write_errors: [] as Array<{ id: string; reason: string }>,
    samples: [] as Array<{ id: string; before: string; after: string }>,
  }

  // Primera pasada: clasificar (sin escribir)
  const toUpdate: Array<{ id: string; before: string; after: string }> = []
  for (const lead of rows) {
    const normalized = normalizeMexicanPhone(lead.telefono)
    if (!normalized) {
      stats.invalid++
      continue
    }
    if (normalized === lead.telefono) {
      stats.unchanged++
      continue
    }
    stats.changed++
    toUpdate.push({ id: lead.id, before: lead.telefono, after: normalized })
  }

  // Tomar samples primero (antes de batchear)
  stats.samples = toUpdate.slice(0, 30)

  // Si dry, devolver
  if (dry) return NextResponse.json(stats)

  // Updates en paralelo en batches de 50 (Supabase aguanta sin rate limit)
  const BATCH_SIZE = 50
  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(async (item) => {
      const { error: upErr } = await supabase
        .from('leads')
        .update({ telefono: item.after })
        .eq('id', item.id)
      return { id: item.id, error: upErr?.message || null }
    }))
    for (const r of results) {
      if (r.error) stats.write_errors.push({ id: r.id, reason: r.error })
      else stats.write_ok++
    }
  }

  return NextResponse.json(stats)
}

// La función `normalizeMexicanPhone` se importa de '@/lib/phoneNormalize'.
