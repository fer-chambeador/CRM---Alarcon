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
  // NOTA (1 jun 2026): el select con columnas específicas + range() estaba
  // devolviendo data STALE (ver fila ID 20675a04 que tenía updated_at=created_at
  // en la lista pero updated_at posterior en /llamadas/[id]). Cambiamos a
  // select '*' + limit() para evitar el bug de cache/replica que afectaba los
  // rescates de Patricia, Guadalupe, Martha, Jorge, Gerardo (rebanados de
  // Marcando aunque ya estaban completed/no_answer/voicemail).
  let q = supabase
    .from('llamadas')
    .select(`*, leads:lead_id ( id, nombre, email, empresa, telefono, status, presupuesto, vacante )`, { count: 'exact' })
    .order('updated_at', { ascending: false })
    .limit(limit)

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
