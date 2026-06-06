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
  const prioridad = url.searchParams.get('prioridad') // urgente|normal|baja|todos
  const leadId = url.searchParams.get('lead_id')
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500)

  const supabase = createServiceClient()
  let q = supabase
    .from('follow_ups')
    .select('id, lead_id, titulo, notas, fecha, tipo, prioridad, completado, completado_at, source, gcal_event_id, created_at, updated_at', { count: 'exact' })
    .gte('created_at', '2000-01-01T00:00:00Z') // no-op para variar query string
    .order('fecha', { ascending: true })
    .limit(limit)

  if (status === 'pendientes') q = q.eq('completado', false)
  else if (status === 'completados') q = q.eq('completado', true)

  if (prioridad && ['urgente', 'normal', 'baja'].includes(prioridad)) {
    q = q.eq('prioridad', prioridad)
  }

  if (leadId) q = q.eq('lead_id', leadId)

  // Filtros de rango en hora MX
  //
  // FIX (4 jun 2026): antes esto era buggy en servidor con timezone != MX:
  //   `new Date(now.toLocaleString('en-US', {timeZone:'America/Mexico_City'}))`
  // parsea el string EN LA ZONA LOCAL DEL SERVIDOR, no en MX. Si Railway corre
  // en UTC, startOfDayMx representaba medianoche UTC, no MX. Los filtros
  // hoy/mañana/semana quedaban corridos 6 horas.
  //
  // AHORA: usamos Intl.DateTimeFormat con formatToParts para construir el
  // string ISO de medianoche MX, independiente del timezone del servidor.
  const now = new Date()
  const mxFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const todayMxStr = mxFormatter.format(now) // YYYY-MM-DD en hora MX
  // MX es UTC-6 todo el año (sin DST desde 2022)
  const startOfDayMx = new Date(`${todayMxStr}T00:00:00-06:00`)
  const endOfTodayMx = new Date(`${todayMxStr}T23:59:59.999-06:00`)
  const startOfTomorrowMx = new Date(startOfDayMx); startOfTomorrowMx.setUTCDate(startOfTomorrowMx.getUTCDate() + 1)
  const endOfTomorrowMx = new Date(endOfTodayMx); endOfTomorrowMx.setUTCDate(endOfTomorrowMx.getUTCDate() + 1)
  const endOfWeekMx = new Date(endOfTodayMx); endOfWeekMx.setUTCDate(endOfWeekMx.getUTCDate() + 7)

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIPO_OK = new Set(['llamada', 'mensaje', 'pago', 'presentacion', 'general'])
const SOURCE_OK = new Set(['manual', 'gcal_import', 'auto_presentacion', 'auto_post_call'])
const PRIORIDAD_OK = new Set(['urgente', 'normal', 'baja'])

// Heurística para auto-priorizar cuando el caller no manda explícitamente
function autoPriorityFor(tipo: string): 'urgente' | 'normal' | 'baja' {
  if (tipo === 'pago') return 'urgente'
  if (tipo === 'presentacion') return 'urgente'  // primer follow-up de presentación = urgente
  return 'normal'
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || !body.titulo || !body.fecha) {
    return NextResponse.json({ error: 'titulo y fecha son requeridos' }, { status: 400 })
  }
  // Validar fecha
  const fechaDate = new Date(body.fecha)
  if (isNaN(fechaDate.getTime())) {
    return NextResponse.json({ error: 'fecha inválida' }, { status: 400 })
  }
  // Validar lead_id si viene
  if (body.lead_id && !UUID_RE.test(String(body.lead_id))) {
    return NextResponse.json({ error: 'lead_id no es UUID válido' }, { status: 400 })
  }
  // Validar tipo si viene
  const tipo = body.tipo || 'general'
  if (!TIPO_OK.has(tipo)) {
    return NextResponse.json({ error: `tipo inválido (${tipo}). Debe ser uno de: ${Array.from(TIPO_OK).join(', ')}` }, { status: 400 })
  }
  // Validar source si viene
  const source = body.source || 'manual'
  if (!SOURCE_OK.has(source)) {
    return NextResponse.json({ error: `source inválido (${source})` }, { status: 400 })
  }

  // Validar prioridad si viene; sino aplicar auto-heurística por tipo
  let prioridad = body.prioridad as string | undefined
  if (prioridad && !PRIORIDAD_OK.has(prioridad)) {
    return NextResponse.json({ error: `prioridad inválida (${prioridad}). Debe ser: urgente | normal | baja` }, { status: 400 })
  }
  if (!prioridad) prioridad = autoPriorityFor(tipo)

  const supabase = createServiceClient()
  const row = {
    lead_id: body.lead_id || null,
    titulo: String(body.titulo).slice(0, 500),
    notas: body.notas ? String(body.notas).slice(0, 5000) : null,
    fecha: fechaDate.toISOString(),
    tipo,
    prioridad,
    source,
    gcal_event_id: body.gcal_event_id || null,
  }
  const { data, error } = await supabase.from('follow_ups').insert(row).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ follow_up: data })
}
