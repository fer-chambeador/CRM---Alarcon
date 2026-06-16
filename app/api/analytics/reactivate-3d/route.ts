import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/analytics/reactivate-3d?from=ISO&to=ISO
 *
 * Breakdown específico de los outbound del botón "Reactivar Vambe >3d"
 * (tipo='reactivate_3d_sent'), separados del template_sent original.
 *
 * Devuelve: cuántos se enviaron, cuántos avanzaron a llamada_agendada+,
 * cuántos convirtieron, y la lista de leads con su status actual.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const from = url.searchParams.get('from') || '2026-06-09T00:00:00Z'
  const to = url.searchParams.get('to') || new Date().toISOString()

  const supabase = createServiceClient()

  // 1. Lead IDs únicos que recibieron reactivate_3d_sent en el rango
  let q3d = supabase
    .from('lead_actividad')
    .select('lead_id, created_at')
    .eq('tipo', 'reactivate_3d_sent')
    .not('lead_id', 'is', null)
    .gte('created_at', from)
    .lte('created_at', to)
  const { data: r3dActs } = await q3d
  const reactivate3dLeadIds = Array.from(new Set(((r3dActs ?? []) as Array<{ lead_id: string }>).map(r => r.lead_id)))

  // 2. Lead IDs únicos del template_sent original
  let qOld = supabase
    .from('lead_actividad')
    .select('lead_id, created_at')
    .eq('tipo', 'template_sent')
    .not('lead_id', 'is', null)
    .gte('created_at', from)
    .lte('created_at', to)
  const { data: oldActs } = await qOld
  const templateSentLeadIds = Array.from(new Set(((oldActs ?? []) as Array<{ lead_id: string }>).map(r => r.lead_id)))

  const POST_LLAMADA = new Set([
    'llamada_agendada', 'llamada_con_dapta', 'no_show_llamada',
    'presentacion_enviada', 'espera_aprobacion', 'liga_pago_enviada',
    'convertido', 'cliente_recurrente',
  ])
  const CERRADOS = new Set(['convertido', 'cliente_recurrente'])

  async function getStats(ids: string[]) {
    if (ids.length === 0) return { sent: 0, pidio_llamada: 0, convertidos: 0, leads_llamada: [], leads_convertidos: [] }
    const CHUNK = 100
    const all: Array<{ id: string; status: string; nombre: string | null; empresa: string | null; telefono: string | null }> = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const { data } = await supabase.from('leads').select('id, status, nombre, empresa, telefono').in('id', chunk)
      if (data) all.push(...(data as typeof all))
    }
    const pidio_llamada = all.filter(l => POST_LLAMADA.has(l.status))
    const convertidos = all.filter(l => CERRADOS.has(l.status))
    return {
      sent: ids.length,
      pidio_llamada: pidio_llamada.length,
      convertidos: convertidos.length,
      leads_llamada: pidio_llamada.map(l => ({ id: l.id, nombre: l.nombre, empresa: l.empresa, telefono: l.telefono, status: l.status })),
      leads_convertidos: convertidos.map(l => ({ id: l.id, nombre: l.nombre, empresa: l.empresa, telefono: l.telefono, status: l.status })),
    }
  }

  const reactivate_3d = await getStats(reactivate3dLeadIds)
  const template_sent = await getStats(templateSentLeadIds)

  return NextResponse.json({
    range: { from, to },
    reactivate_3d,
    template_sent,
  })
}
