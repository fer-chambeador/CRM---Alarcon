import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

/**
 * GET /api/follow-ups?status=pendientes|completados|todos&range=hoy|manana|semana|atrasados|todos&lead_id=
 * POST /api/follow-ups  { lead_id?, titulo, notas?, fecha, tipo? }
 */

type Lead = { id: string; nombre: string | null; email: string | null; empresa: string | null; telefono: string | null; status: string }

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const status = url.searchParams.get('status') || 'todos'
  const range = url.searchParams.get('range') || 'todos'
  const leadId = url.searchParams.get('lead_id')
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500)

  const supabase = createServiceClient()
  let q = supabase
    .from('follow_ups')
    .select('id, lead_id, titulo, notas, fecha, tipo, completado, completado_at, source, gcal_event_id, created_at, updated_at', { count: 'exact' })
    .gte('created_at', '2000-01-01T00:00:00Z') // no-op para variar query string
    .order('fecha', { ascending: true })
    .limit(limit)

  if (status === 'pendientes') q = q.eq('completado', false)
  else if (status === 'completados') q = q.eq('completado', true)

  if (leadId) q = q.eq('lead_id', leadId)

  // Filtros de rango en hora MX
  const now = new Date()
  const startOfDayMx = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }))
  startOfDayMx.setHours(0, 0, 0, 0)
  const endOfTodayMx = new Date(startOfDayMx); endOfTodayMx.setHours(23, 59, 59, 999)
  const startOfTomorrowMx = new Date(startOfDayMx); startOfTomorrowMx.setDate(startOfTomorrowMx.getDate() + 1)
  const endOfTomorrowMx = new Date(endOfTodayMx); endOfTomorrowMx.setDate(endOfTomorrowMx.getDate() + 1)
  const endOfWeekMx = new Date(startOfDayMx); endOfWeekMx.setDate(endOfWeekMx.getDate() + 7); endOfWeekMx.setHours(23, 59, 59, 999)

  if (range === 'hoy') {
    q = q.gte('fecha', startOfDayMx.toISOString()).lte('fecha', endOfTodayMx.toISOString())
  } else if (range === 'manana') {
    q = q.gte('fecha', startOfTomorrowMx.toISOString()).lte('fecha', endOfTomorrowMx.toISOString())
  } else if (range === 'semana') {
    q = q.gte('fecha', startOfDayMx.toISOString()).lte('fecha', endOfWeekMx.toISOString())
  } else if (range === 'atrasados') {
    q = q.lt('fecha', startOfDayMx.toISOString()).eq('completado', false)
  }

  const { data: fups, error, count } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Join leads
  const followUps = (fups ?? []) as Array<Record<string, unknown> & { lead_id: string | null }>
  const leadIds = Array.from(new Set(followUps.map(f => f.lead_id).filter((x): x is string => !!x)))
  const leadsById = new Map<string, Lead>()
  if (leadIds.length > 0) {
    const { data: leadsData } = await supabase
      .from('leads')
      .select('id, nombre, email, empresa, telefono, status')
      .in('id', leadIds)
    if (leadsData) for (const l of leadsData as Lead[]) leadsById.set(l.id, l)
  }

  const merged = followUps.map(f => ({ ...f, lead: f.lead_id ? leadsById.get(f.lead_id) ?? null : null }))
  const res = NextResponse.json({ follow_ups: merged, total: count || 0 })
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  return res
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !body.titulo || !body.fecha) {
    return NextResponse.json({ error: 'titulo y fecha son requeridos' }, { status: 400 })
  }
  const supabase = createServiceClient()
  const row = {
    lead_id: body.lead_id || null,
    titulo: String(body.titulo).slice(0, 500),
    notas: body.notas ? String(body.notas).slice(0, 5000) : null,
    fecha: body.fecha,
    tipo: body.tipo || 'general',
    source: body.source || 'manual',
    gcal_event_id: body.gcal_event_id || null,
  }
  const { data, error } = await supabase.from('follow_ups').insert(row).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ follow_up: data })
}
