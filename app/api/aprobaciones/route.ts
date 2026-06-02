import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

/**
 * GET /api/aprobaciones — lista aprobaciones pending con el lead embebido.
 *
 * Response: { vambe: [...], dapta: [...], counts: { vambe, dapta, total } }
 *
 * BUG FIX (2 jun 2026): antes usaba JOIN embebido de supabase-js
 * (`select '*, leads:lead_id (...)')`) — ese JOIN cae en un cache stale del
 * cliente y NO devuelve aprobaciones creadas hace pocos minutos (caso Daniel
 * + Tania, 2 jun 2026: el cron creó 2 aprobaciones nuevas, SQL directo las
 * mostraba, pero el endpoint seguía retornando solo las 2 viejas de Jovanny
 * y Emily). Fix: separar en 2 queries SIN JOIN y mergear en JS. Mismo
 * patrón que /api/llamadas y /api/analytics/dapta.
 */
type AproRow = Record<string, unknown> & {
  id: string
  tipo: 'vambe_template' | 'dapta_call'
  lead_id: string
}
type LeadRow = {
  id: string
  nombre: string | null
  email: string | null
  empresa: string | null
  telefono: string | null
  vacante: string | null
  presupuesto: string | null
  puesto: string | null
  status: string
  canal_adquisicion: string | null
  llamada_at: string | null
  monto: number | null
  notas: string | null
  created_at: string
}

export async function GET() {
  const supabase = createServiceClient()

  // Query 1 — aprobaciones pending, sin JOIN. Filtro no-op (gte created_at)
  // para variar el query string cada request y bypassear cualquier stale
  // statement cache del cliente.
  const { data: aprosData, error } = await supabase
    .from('aprobaciones')
    .select('*')
    .eq('status', 'pending')
    .gte('created_at', '2000-01-01T00:00:00Z')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const apros = (aprosData ?? []) as AproRow[]

  // Query 2 — leads por IDs (in clause). Solo si hay aprobaciones.
  const leadIds = Array.from(new Set(apros.map(a => a.lead_id).filter((x): x is string => !!x)))
  const leadsById = new Map<string, LeadRow>()
  if (leadIds.length > 0) {
    const { data: leadsData } = await supabase
      .from('leads')
      .select('id, nombre, email, empresa, telefono, vacante, presupuesto, puesto, status, canal_adquisicion, llamada_at, monto, notas, created_at')
      .in('id', leadIds)
    for (const l of ((leadsData ?? []) as LeadRow[])) {
      leadsById.set(l.id, l)
    }
  }

  // Merge — agregar lead nested para mantener el shape esperado por OutboundClient.
  const merged = apros.map(a => ({
    ...a,
    leads: a.lead_id ? (leadsById.get(a.lead_id) ?? null) : null,
  }))

  const vambe = merged.filter(r => r.tipo === 'vambe_template')
  const dapta = merged.filter(r => r.tipo === 'dapta_call')

  const res = NextResponse.json({
    vambe,
    dapta,
    counts: { vambe: vambe.length, dapta: dapta.length, total: vambe.length + dapta.length },
  })
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.headers.set('Pragma', 'no-cache')
  res.headers.set('Expires', '0')
  return res
}
