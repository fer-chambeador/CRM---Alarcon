import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { fetchRecurrentes } from '@/lib/recurrentes'

export const dynamic = 'force-dynamic'

/**
 * POST /api/recurrentes/enrich-emails
 *
 * Recorre los clientes recurrentes que NO tienen email y los busca en
 * la tabla `leads` del CRM (mismo Supabase). Si encuentra match por
 * empresa o nombre, mete el email como override en
 * clientes_recurrentes_meta.
 *
 * Devuelve un resumen:
 *   { enriched: N, skipped: M, total_sin_email: T, samples: [...] }
 */
export async function POST() {
  const supabase = createServiceClient()
  const t0 = Date.now()

  const { clientes } = await fetchRecurrentes()
  const sinEmail = clientes.filter(c => !c.email && !c.hidden)

  // Traemos todos los leads una vez (más eficiente que N queries)
  const { data: leadsRaw, error } = await supabase
    .from('leads')
    .select('email, nombre, empresa')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const leads = (leadsRaw || []) as Array<{ email: string; nombre: string | null; empresa: string | null }>

  // Helper: normalizar para matching (lowercase + sin acentos + sin
  // caracteres no alfanuméricos + sin "S.A. de C.V.", "SRL", etc.)
  const norm = (s: string | null | undefined) => (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(s\.?a\.?(\sde\sc\.?v\.?)?|s\.?r\.?l\.?|inc\.?|llc\.?|corp\.?|ltd\.?)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()

  // Indexar leads por nombre y empresa normalizado
  type Idx = Map<string, string[]>  // key → emails
  const byEmpresa: Idx = new Map()
  const byNombre: Idx = new Map()
  for (const l of leads) {
    if (!l.email) continue
    const ke = norm(l.empresa)
    const kn = norm(l.nombre)
    if (ke) {
      const arr = byEmpresa.get(ke) || []
      arr.push(l.email)
      byEmpresa.set(ke, arr)
    }
    if (kn) {
      const arr = byNombre.get(kn) || []
      arr.push(l.email)
      byNombre.set(kn, arr)
    }
  }

  type Match = { cliente_key: string; cliente: string; email: string; matched_by: 'empresa' | 'nombre' | 'partial' }
  const matches: Match[] = []

  for (const c of sinEmail) {
    const k = norm(c.cliente)
    if (!k) continue

    // 1) Match exacto por empresa
    let found = byEmpresa.get(k)
    if (found && found.length) {
      matches.push({ cliente_key: c.key, cliente: c.cliente, email: found[0], matched_by: 'empresa' })
      continue
    }
    // 2) Match exacto por nombre
    found = byNombre.get(k)
    if (found && found.length) {
      matches.push({ cliente_key: c.key, cliente: c.cliente, email: found[0], matched_by: 'nombre' })
      continue
    }
    // 3) Match parcial — k es substring de alguna key, o viceversa
    let partialEmail: string | null = null
    for (const [leadKey, emails] of Array.from(byEmpresa.entries())) {
      if (leadKey.length >= 4 && (leadKey.includes(k) || k.includes(leadKey)) && emails.length) {
        partialEmail = emails[0]
        break
      }
    }
    if (partialEmail) {
      matches.push({ cliente_key: c.key, cliente: c.cliente, email: partialEmail, matched_by: 'partial' })
    }
  }

  // Aplicar upserts (uno por uno para no chocar con constraints)
  let applied = 0
  for (const m of matches) {
    const { error: upErr } = await supabase
      .from('clientes_recurrentes_meta')
      .upsert({ key: m.cliente_key, email: m.email }, { onConflict: 'key' })
    if (!upErr) applied += 1
  }

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - t0,
    total_sin_email: sinEmail.length,
    matched: matches.length,
    applied,
    skipped: sinEmail.length - matches.length,
    samples: matches.slice(0, 10).map(m => ({ cliente: m.cliente, email: m.email, by: m.matched_by })),
  })
}
