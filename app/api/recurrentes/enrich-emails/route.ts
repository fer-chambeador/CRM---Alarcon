import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { fetchRecurrentes } from '@/lib/recurrentes'

export const dynamic = 'force-dynamic'
export const maxDuration = 60  // permite hasta 60s en Railway

/**
 * POST /api/recurrentes/enrich-emails
 *
 * Recorre clientes recurrentes sin email y los busca en la tabla
 * `leads` del CRM (mismo Supabase). Si encuentra match — exacto o
 * por substring — mete el email como override en
 * clientes_recurrentes_meta.
 *
 * Estrategia de matching (en cascada):
 *   1. Empresa LIKE (más específico)
 *   2. Nombre LIKE
 *   3. Local-part del email LIKE (cuando el email contiene el nombre)
 *
 * Devuelve diagnóstico: cuántos se enriquecieron, cuántos se quedaron
 * sin match, y para los que NO matchearon, hasta 5 candidatos
 * posibles para que el user pueda confirmarlos a mano.
 */

type LeadRow = { email: string; nombre: string | null; empresa: string | null }

// Normalización para matching (lowercase + sin acentos + sin sufijos
// corporativos + sin caracteres no alfanuméricos)
function normKey(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(s\.?a\.?\.?(\sde\sc\.?v\.?)?|s\.?r\.?l\.?|inc\.?|llc\.?|corp\.?|ltd\.?)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()
}

function emailLocalPart(email: string): string {
  return normKey(email.split('@')[0] || '')
}

export async function POST() {
  const supabase = createServiceClient()
  const t0 = Date.now()

  const { clientes } = await fetchRecurrentes()
  const sinEmail = clientes.filter(c => !c.email && !c.hidden)

  // Traer leads una sola vez (más rápido que N queries)
  const { data: leadsRaw, error } = await supabase
    .from('leads')
    .select('email, nombre, empresa')
    .not('email', 'is', null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const leads = (leadsRaw || []) as LeadRow[]

  type Match = {
    cliente_key: string
    cliente: string
    email: string
    matched_by: 'empresa' | 'nombre' | 'email-local' | 'empresa-partial' | 'nombre-partial'
    score: number  // mayor = más alto match quality
  }
  const allMatches: Match[] = []

  for (const c of sinEmail) {
    const ck = normKey(c.cliente)
    if (!ck || ck.length < 3) continue

    const candidates: Match[] = []
    for (const l of leads) {
      const eK = normKey(l.empresa)
      const nK = normKey(l.nombre)
      const elK = emailLocalPart(l.email)

      // Match exacto empresa
      if (eK && eK === ck) {
        candidates.push({ cliente_key: c.key, cliente: c.cliente, email: l.email, matched_by: 'empresa', score: 100 })
        continue
      }
      // Match exacto nombre
      if (nK && nK === ck) {
        candidates.push({ cliente_key: c.key, cliente: c.cliente, email: l.email, matched_by: 'nombre', score: 90 })
        continue
      }
      // Match exacto email-local
      if (elK && elK === ck) {
        candidates.push({ cliente_key: c.key, cliente: c.cliente, email: l.email, matched_by: 'email-local', score: 85 })
        continue
      }
      // Substring (al menos 4 chars de match)
      if (ck.length >= 4) {
        if (eK && (eK.includes(ck) || ck.includes(eK)) && Math.min(eK.length, ck.length) >= 4) {
          candidates.push({ cliente_key: c.key, cliente: c.cliente, email: l.email, matched_by: 'empresa-partial', score: 60 })
          continue
        }
        if (nK && (nK.includes(ck) || ck.includes(nK)) && Math.min(nK.length, ck.length) >= 4) {
          candidates.push({ cliente_key: c.key, cliente: c.cliente, email: l.email, matched_by: 'nombre-partial', score: 55 })
          continue
        }
        if (elK && elK.includes(ck) && ck.length >= 5) {
          candidates.push({ cliente_key: c.key, cliente: c.cliente, email: l.email, matched_by: 'email-local', score: 50 })
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    if (candidates[0]) allMatches.push(candidates[0])
  }

  // Aplicar upserts y capturar errores
  let applied = 0
  const upsertErrors: string[] = []
  for (const m of allMatches) {
    const { error: upErr } = await supabase
      .from('clientes_recurrentes_meta')
      .upsert({ key: m.cliente_key, email: m.email }, { onConflict: 'key' })
    if (upErr) upsertErrors.push(`${m.cliente}: ${upErr.message}`)
    else applied += 1
  }

  // Diagnóstico: clientes que NO matchearon — devolver muestra
  const matchedKeys = new Set(allMatches.map(m => m.cliente_key))
  const noMatch = sinEmail
    .filter(c => !matchedKeys.has(c.key))
    .slice(0, 12)
    .map(c => c.cliente)

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - t0,
    total_sin_email: sinEmail.length,
    matched: allMatches.length,
    applied,
    skipped: sinEmail.length - allMatches.length,
    leads_count: leads.length,
    samples_matched: allMatches.slice(0, 8).map(m => ({
      cliente: m.cliente, email: m.email, by: m.matched_by, score: m.score,
    })),
    samples_unmatched: noMatch,
    upsert_errors: upsertErrors.slice(0, 5),
  })
}
