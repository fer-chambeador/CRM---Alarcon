import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

/**
 * GET /api/analytics/dapta?from=ISO&to=ISO
 *
 * 7 métricas Dapta + Vambe.
 *
 * BUG FIXED (2 jun 2026): este endpoint devolvía data STALE cuando llegaba
 * solo `from` sin `to`. Causa: (1) `qX.gte(...)` SIN reasignar — supabase-js
 * retorna nueva instancia y la mutación se perdía; (2) cache stale layer
 * de supabase-js cuando la URL del query es idéntica entre requests.
 *
 * Fix:
 *   - Si no llega `to`, usamos NOW (garantiza URL única por request).
 *   - Reasignamos el query builder en cada chain (let qX = qX.gte(...)).
 *   - Headers Cache-Control: no-store.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const from = url.searchParams.get('from')
  // Si no llega `to`, usamos NOW (varía cada request, bypass de stale cache).
  const to = url.searchParams.get('to') || new Date().toISOString()

  const supabase = createServiceClient()

  // ── 1. Dapta llamadas exitosas (>= 3 min, completadas) ──
  let qExit = supabase
    .from('llamadas')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed')
    .gte('duration_seconds', 180)
  if (from) qExit = qExit.gte('created_at', from)
  qExit = qExit.lte('created_at', to)
  const { count: daptaExitosas } = await qExit

  // ── 2. Dapta convertidas: leads únicos con llamada Y status cerrado ──
  let qConv = supabase
    .from('llamadas')
    .select('lead_id, leads:lead_id ( status )')
    .not('dapta_call_id', 'is', null)
    .not('lead_id', 'is', null)
  if (from) qConv = qConv.gte('created_at', from)
  qConv = qConv.lte('created_at', to)
  const { data: convRows } = await qConv
  const rows = (convRows ?? []) as Array<{
    lead_id: string | null
    leads: { status?: string } | { status?: string }[] | null
  }>
  const convertedLeadIds = new Set<string>()
  for (const r of rows) {
    if (!r.lead_id) continue
    const leadsField = r.leads
    const s = Array.isArray(leadsField) ? leadsField[0]?.status : leadsField?.status
    if (s === 'convertido' || s === 'cliente_recurrente') {
      convertedLeadIds.add(r.lead_id)
    }
  }
  const daptaConvertidas = convertedLeadIds.size

  // ── 3. Llamadas agendadas (scheduled_at en rango) ──
  let qAgend = supabase
    .from('llamadas')
    .select('id', { count: 'exact', head: true })
    .not('scheduled_at', 'is', null)
  if (from) qAgend = qAgend.gte('scheduled_at', from)
  qAgend = qAgend.lte('scheduled_at', to)
  const { count: llamadasAgendadas } = await qAgend

  // ── 4. Llamadas manuales (agendadas - llamadas con dapta_call_id) ──
  // Estas son las llamadas que Fer tuvo que hacer porque Dapta no las tomó
  // (sea porque falló, porque Fer la llamó manual antes, o porque el cron
  // no la disparó). Métrica útil para medir el costo operativo de Fer.
  // Fórmula: total agendadas en el rango − llamadas con dapta_call_id en el rango.
  let qDaptaDisparadas = supabase
    .from('llamadas')
    .select('id', { count: 'exact', head: true })
    .not('dapta_call_id', 'is', null)
  if (from) qDaptaDisparadas = qDaptaDisparadas.gte('scheduled_at', from)
  qDaptaDisparadas = qDaptaDisparadas.lte('scheduled_at', to)
  const { count: daptaDisparadas } = await qDaptaDisparadas
  const llamadasManuales = Math.max(0, (llamadasAgendadas ?? 0) - (daptaDisparadas ?? 0))

  // ── 5. Vambe outbound mensajes enviados ──
  let qMsgs = supabase
    .from('lead_actividad')
    .select('id', { count: 'exact', head: true })
    .eq('tipo', 'template_sent')
  if (from) qMsgs = qMsgs.gte('created_at', from)
  qMsgs = qMsgs.lte('created_at', to)
  const { count: vambeOutboundMsgs } = await qMsgs

  // ── 6 & 7. Outbound funnel ──
  let qOutboundActs = supabase
    .from('lead_actividad')
    .select('lead_id')
    .eq('tipo', 'template_sent')
    .not('lead_id', 'is', null)
  if (from) qOutboundActs = qOutboundActs.gte('created_at', from)
  qOutboundActs = qOutboundActs.lte('created_at', to)
  const { data: outboundActs } = await qOutboundActs
  const outboundLeadIds = Array.from(
    new Set(((outboundActs ?? []) as Array<{ lead_id: string }>).map(r => r.lead_id)),
  )

  let outboundPidioLlamada = 0
  let outboundConvertidos = 0
  if (outboundLeadIds.length > 0) {
    const { data: outboundLeadsData } = await supabase
      .from('leads')
      .select('id, status')
      .in('id', outboundLeadIds)
    const POST_LLAMADA = new Set([
      'llamada_agendada',
      'llamada_con_dapta',
      'no_show_llamada',
      'presentacion_enviada',
      'espera_aprobacion',
      'convertido',
      'cliente_recurrente',
    ])
    const CERRADOS = new Set(['convertido', 'cliente_recurrente'])
    for (const l of ((outboundLeadsData ?? []) as Array<{ id: string; status: string }>)) {
      if (POST_LLAMADA.has(l.status)) outboundPidioLlamada++
      if (CERRADOS.has(l.status))     outboundConvertidos++
    }
  }

  const res = NextResponse.json({
    dapta_exitosas: daptaExitosas ?? 0,
    dapta_convertidas: daptaConvertidas,
    llamadas_agendadas: llamadasAgendadas ?? 0,
    llamadas_manuales: llamadasManuales,
    conversiones_manuales: llamadasManuales,  // deprecated alias para compatibilidad — usar llamadas_manuales en código nuevo
    vambe_outbound_msgs: vambeOutboundMsgs ?? 0,
    outbound_pidio_llamada: outboundPidioLlamada,
    outbound_convertidos: outboundConvertidos,
    outbound_total_leads_unicos: outboundLeadIds.length,
  })
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.headers.set('Pragma', 'no-cache')
  res.headers.set('Expires', '0')
  return res
}
