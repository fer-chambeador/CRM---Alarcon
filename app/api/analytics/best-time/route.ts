import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/analytics/best-time
 *
 * Calcula el "mejor momento para contactar leads" analizando:
 *   - A qué hora/día de la semana se RESPONDE más (lead → CRM message)
 *   - A qué hora/día se cierran más ventas (status → convertido)
 *
 * Devuelve una matriz heatmap-style:
 *   {
 *     by_hour: { '0': N, '1': N, ..., '23': N },
 *     by_dow:  { '0': N, ..., '6': N },              // 0 = domingo
 *     by_hour_canal: { [canal]: { [hour]: N } },     // segmentado por canal
 *     best_hour, best_dow,                            // pico simple
 *     sample_size
 *   }
 */
export async function GET(_req: NextRequest) {
  const supabase = createServiceClient()

  // Eventos que cuentan como "lead actividad positiva": mensajes inbound,
  // stage changes a llamada_agendada / convertido. Tomamos lead_actividad.
  const { data: events, error } = await supabase
    .from('lead_actividad')
    .select('tipo, created_at, lead_id')
    .in('tipo', ['vambe_message', 'vambe_stage_change', 'status_change'])
    .order('created_at', { ascending: false })
    .limit(3000)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Para enriquecer con canal, traemos los canales de los leads que aparecen
  const leadIds = Array.from(new Set((events || []).map(e => e.lead_id))).filter(Boolean)
  let canalByLead: Record<string, string | null> = {}
  if (leadIds.length) {
    const { data: leads } = await supabase
      .from('leads')
      .select('id, canal_adquisicion')
      .in('id', leadIds as string[])
    for (const l of leads || []) canalByLead[l.id as string] = (l.canal_adquisicion as string) || null
  }

  // Contar por hora y día de semana, usando zona horaria America/Mexico_City
  const byHour: Record<string, number> = {}
  const byDow: Record<string, number> = {}
  const byHourCanal: Record<string, Record<string, number>> = {}
  for (let h = 0; h < 24; h++) byHour[String(h)] = 0
  for (let d = 0; d < 7; d++) byDow[String(d)] = 0

  for (const e of events || []) {
    const d = new Date(e.created_at as string)
    if (isNaN(d.getTime())) continue
    // Convertir a hora local MX (-06:00 sin DST, -05:00 con — aproximamos -06 que es más común)
    const local = new Date(d.getTime() - 6 * 3600 * 1000)
    const hour = local.getUTCHours()
    const dow = local.getUTCDay()      // 0 = domingo
    byHour[String(hour)]++
    byDow[String(dow)]++
    const canal = canalByLead[e.lead_id as string] || '(sin canal)'
    if (!byHourCanal[canal]) {
      byHourCanal[canal] = {}
      for (let h = 0; h < 24; h++) byHourCanal[canal][String(h)] = 0
    }
    byHourCanal[canal][String(hour)]++
  }

  // Pico simple
  let bestHour = '0', bestHourCount = 0
  for (const [h, c] of Object.entries(byHour)) {
    if (c > bestHourCount) { bestHour = h; bestHourCount = c }
  }
  let bestDow = '0', bestDowCount = 0
  for (const [d, c] of Object.entries(byDow)) {
    if (c > bestDowCount) { bestDow = d; bestDowCount = c }
  }

  const DOW_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

  return NextResponse.json({
    by_hour: byHour,
    by_dow: byDow,
    by_hour_canal: byHourCanal,
    best_hour: { hour: parseInt(bestHour, 10), count: bestHourCount },
    best_dow: { dow: parseInt(bestDow, 10), name: DOW_NAMES[parseInt(bestDow, 10)], count: bestDowCount },
    sample_size: (events || []).length,
    timezone_note: 'Hora ajustada a -06:00 (CDMX aprox sin DST)',
  })
}
