import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { requireBotAuth } from '../../_lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bot/_debug/llamadas
 *
 * Debug helper — devuelve las últimas 20 llamadas SIN filtros de fecha,
 * para ver qué hay realmente en la tabla y cómo se ven los scheduled_at.
 * Muestra columnas raw para diagnosticar formato de timestamps.
 */
export async function GET(req: NextRequest) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  const supabase = createServiceClient()

  // Sin filtros — última semana ordenado desc
  const { data, error } = await supabase
    .from('llamadas')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // También conteo total en la tabla
  const { count } = await supabase
    .from('llamadas').select('*', { count: 'exact', head: true })

  // Estadísticas de scheduled_at
  const total = data?.length || 0
  const withScheduled = (data || []).filter((l) => l.scheduled_at).length
  const nullScheduled = total - withScheduled

  return NextResponse.json({
    total_en_tabla: count,
    ultimas_20: {
      count: total,
      con_scheduled_at: withScheduled,
      sin_scheduled_at: nullScheduled,
    },
    columnas_de_primera_fila: data?.[0] ? Object.keys(data[0]) : [],
    sample: (data || []).slice(0, 5).map((l) => ({
      id: l.id,
      lead_id: l.lead_id,
      scheduled_at: l.scheduled_at,
      status: l.status,
      created_at: l.created_at,
      dapta_call_id: l.dapta_call_id,
      outcome: l.outcome,
    })),
  })
}
