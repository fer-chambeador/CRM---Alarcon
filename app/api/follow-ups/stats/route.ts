import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

/**
 * GET /api/follow-ups/stats
 *
 * Devuelve contadores correctos de cada bucket sin importar qué filtro
 * tenga activo el usuario en /follow-ups.
 *
 * BUG FIX (audit 17-jun-2026): el cliente FollowUpsClient.tsx calculaba
 * stats.completados con `items.filter(i => i.completado).length`, pero
 * items venía filtrado del backend por status='pendientes', por lo que
 * completados SIEMPRE era 0. Idem para "Hoy" cuando el rango activo no
 * incluía hoy. Ahora el cliente fetcha este endpoint para los counts
 * que mostrar en los chips, independiente del listado.
 *
 * Performance: 4 queries .select('id', count: 'exact', head: true)
 * son ~80ms total en Supabase. No es free pero es muy barato para una
 * página que se carga 1 vez por día.
 */
export async function GET() {
  const supabase = createServiceClient()

  // Helper: construir startOfDayMx / endOfTodayMx en hora MX
  // (mismo patrón que el GET principal — UTC-6 fijo desde 2022)
  const now = new Date()
  const mxFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const todayMxStr = mxFormatter.format(now) // YYYY-MM-DD MX
  const startOfDayMx = new Date(`${todayMxStr}T00:00:00-06:00`)
  const endOfTodayMx = new Date(`${todayMxStr}T23:59:59.999-06:00`)

  const [pendientesRes, completadosRes, atrasadosRes, hoyRes] = await Promise.all([
    supabase.from('follow_ups').select('id', { count: 'exact', head: true }).eq('completado', false),
    supabase.from('follow_ups').select('id', { count: 'exact', head: true }).eq('completado', true),
    supabase.from('follow_ups').select('id', { count: 'exact', head: true })
      .eq('completado', false)
      .lt('fecha', startOfDayMx.toISOString()),
    supabase.from('follow_ups').select('id', { count: 'exact', head: true })
      .eq('completado', false)
      .gte('fecha', startOfDayMx.toISOString())
      .lte('fecha', endOfTodayMx.toISOString()),
  ])

  return NextResponse.json({
    pendientes: pendientesRes.count ?? 0,
    completados: completadosRes.count ?? 0,
    atrasados: atrasadosRes.count ?? 0,
    hoy: hoyRes.count ?? 0,
  }, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' }
  })
}
