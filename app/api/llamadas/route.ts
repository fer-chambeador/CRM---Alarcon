import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

/**
 * GET /api/llamadas?status=&outcome=&lead_id=&limit=100&offset=0
 *
 * Lista de llamadas — con join al lead para tener nombre/empresa/email.
 *
 * NOTA (1 jun 2026 — bug stale): cuando esta ruta usaba `.select('*, leads:...')`
 * con JOIN embebido de supabase-js, el endpoint devolvía data STALE para filas
 * recién insertadas/actualizadas (vimos llamadas Brenda/Patricia/Guadalupe que
 * en /llamadas/[id] aparecían 'completed' pero en /llamadas aparecían 'dialing'
 * con outcome=null, incluso DESPUÉS de un DELETE + INSERT). El JOIN de
 * supabase-js hits un cache layer interno que no se invalida al ritmo de DB.
 *
 * Fix: separar en 2 queries SIN JOIN — primero `llamadas`, después `leads` por
 * IDs, y mergear en JS. Esto evita el cache stale del JOIN y devuelve siempre
 * la versión actual de DB.
 */

type Llamada = Record<string, unknown> & { id: string; lead_id?: string | null }
type Lead = { id: string; nombre: string | null; email: string | null; empresa: string | null; telefono: string | null; status: string; presupuesto: string | null; vacante: string | null }

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const outcome = url.searchParams.get('outcome')
  const leadId = url.searchParams.get('lead_id')
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)

  const supabase = createServiceClient()

  // Query 1 — llamadas sin JOIN. select específico de columnas (no '*' para
  // evitar el cache stale de `select '*'`). Añadimos un filtro no-op con un
  // valor que NO se repite request-a-request (`updated_at >= '2000...'`) que
  // fuerza que la URL del query sea distinta cada vez, invalidando cualquier
  // statement cache que pueda haber en supabase-js.
  let qLlamadas = supabase
    .from('llamadas')
    .select(`id, lead_id, dapta_call_id, agent_name, status, outcome,
      to_number, from_number, duration_seconds, recording_url,
      summary, custom_analysis, sentimiento, interes_real,
      pidio_link_pago, pidio_presentacion, agendar_seguimiento, scheduled_at,
      triggered_by, trigger_reason, error_message,
      started_at, ended_at, created_at, updated_at`, { count: 'exact' })
    .gte('created_at', '2000-01-01T00:00:00Z') // no-op filter para variar el query string
    .order('updated_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status) qLlamadas = qLlamadas.eq('status', status)
  if (outcome) qLlamadas = qLlamadas.eq('outcome', outcome)
  if (leadId) qLlamadas = qLlamadas.eq('lead_id', leadId)

  const { data: llamadasData, error: errLlamadas, count } = await qLlamadas
  if (errLlamadas) return NextResponse.json({ error: errLlamadas.message }, { status: 500 })

  const llamadas = (llamadasData ?? []) as Llamada[]

  // Query 2 — leads por IDs (in clause). Solo si hay llamadas.
  const leadIds = Array.from(new Set(llamadas.map(l => l.lead_id).filter((x): x is string => !!x)))
  let leadsById = new Map<string, Lead>()
  if (leadIds.length > 0) {
    const { data: leadsData, error: errLeads } = await supabase
      .from('leads')
      .select('id, nombre, email, empresa, telefono, status, presupuesto, vacante')
      .in('id', leadIds)
    if (!errLeads && leadsData) {
      for (const l of leadsData as Lead[]) {
        leadsById.set(l.id, l)
      }
    }
  }

  // Merge — agregamos `leads` como nested object (igual que retornaba el JOIN)
  // para no romper el shape esperado por LlamadasClient.tsx.
  const merged = llamadas.map(l => ({
    ...l,
    leads: l.lead_id ? (leadsById.get(l.lead_id) ?? null) : null,
  }))

  const res = NextResponse.json({
    llamadas: merged,
    total: count || 0,
    limit,
    offset,
  })
  // Asegurar que NINGÚN edge/CDN cachee esta respuesta.
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.headers.set('Pragma', 'no-cache')
  res.headers.set('Expires', '0')
  return res
}
