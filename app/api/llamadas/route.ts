import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/llamadas?status=&outcome=&lead_id=&limit=100&offset=0
 *
 * Lista de llamadas — con join al lead para tener nombre/empresa/email.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const outcome = url.searchParams.get('outcome')
  const leadId = url.searchParams.get('lead_id')
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)

  const supabase = createServiceClient()
  let q = supabase
    .from('llamadas')
    .select(`
      id, lead_id, dapta_call_id, agent_name, status, outcome,
      to_number, from_number, duration_seconds, recording_url,
      summary, custom_analysis, sentimiento, interes_real,
      pidio_link_pago, pidio_presentacion, agendar_seguimiento, scheduled_at,
      triggered_by, trigger_reason, error_message,
      started_at, ended_at, created_at, updated_at,
      leads:lead_id ( id, nombre, email, empresa, telefono, status, presupuesto, vacante )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) q = q.eq('status', status)
  if (outcome) q = q.eq('outcome', outcome)
  if (leadId) q = q.eq('lead_id', leadId)

  const { data, error, count } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    llamadas: data || [],
    total: count || 0,
    limit,
    offset,
  })
}
