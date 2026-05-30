import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

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
    if (stats.samples.length < 30) {
      stats.samples.push({ id: lead.id, before: lead.telefono, after: normalized })
    }
    if (!dry) {
      const { error: upErr } = await supabase
        .from('leads')
        .update({ telefono: normalized })
        .eq('id', lead.id)
      if (upErr) {
        stats.write_errors.push({ id: lead.id, reason: upErr.message })
      } else {
        stats.write_ok++
      }
    }
  }

  return NextResponse.json(stats)
}

/**
 * Normaliza un teléfono a formato +52XXXXXXXXXX (México).
 *
 * Casos:
 *   "7701836726"        → "+527701836726"
 *   "5217701836726"     → "+527701836726"  (quita el "1" intermedio de WhatsApp Mobile)
 *   "527701836726"      → "+527701836726"
 *   "+527701836726"     → "+527701836726"  (ya OK)
 *   "+52 770 183 6726"  → "+527701836726"
 *   "abc"               → null
 */
export function normalizeMexicanPhone(raw: string): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/[\s\-()+]/g, '')
  if (!/^\d+$/.test(cleaned)) return null
  const digits = cleaned

  // Caso 1: 10 dígitos → asumir México sin código país
  if (digits.length === 10) return `+52${digits}`

  // Caso 2: 12 dígitos empezando con 52 → ya con código país
  if (digits.length === 12 && digits.startsWith('52')) return `+${digits}`

  // Caso 3: 13 dígitos con "521" (formato WhatsApp Mobile México) → quitar el 1 extra
  if (digits.length === 13 && digits.startsWith('521')) return `+52${digits.slice(3)}`

  // Caso 4: 11 dígitos empezando con 1 → posible formato antiguo MX, quitar el 1
  if (digits.length === 11 && digits.startsWith('1')) return `+52${digits.slice(1)}`

  // Si tiene + y código país no-México, dejarlo así
  if (raw.startsWith('+') && digits.length >= 10) return `+${digits}`

  // Resto: muy ambiguo, no tocar
  return raw
}
