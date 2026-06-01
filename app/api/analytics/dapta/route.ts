import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/analytics/dapta?from=ISO&to=ISO
 *
 * Devuelve 7 métricas operativas del stack Dapta + Vambe:
 *
 *   1. dapta_exitosas         — llamadas con status='completed' Y duration >= 180s
 *                              (3+ min = el cliente realmente conversó)
 *   2. dapta_convertidas      — leads únicos que recibieron llamada Dapta y luego
 *                              cerraron (status convertido o cliente_recurrente)
 *   3. llamadas_agendadas     — llamadas con scheduled_at en el rango
 *   4. conversiones_manuales  — leads cerrados SIN haber pasado por Dapta
 *   5. vambe_outbound_msgs    — count de lead_actividad tipo='template_sent'
 *   6. outbound_pidio_llamada — leads únicos con template_sent que luego escalaron
 *   7. outbound_convertidos   — leads únicos con template_sent que cerraron
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')

  const supabase = createServiceClient()

  // ── 1. Dapta llamadas exitosas (>= 3 min) ──
  const qExit = supabase
    .from('llamadas')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed')
    .gte('duration_seconds', 180)
  if (from) qExit.gte('started_at', from)
  if (to)   qExit.lte('started_at', to)
  const { count: daptaExitosas } = await qExit

  // ── 2. Dapta llamadas convertidas ──
  // Leads únicos que recibieron una llamada (dapta_call_id NOT NULL) Y su
  // lead.status quedó en convertido / cliente_recurrente.
  const qConv = supabase
    .from('llamadas')
    .select('lead_id, leads:lead_id ( status )')
    .not('dapta_call_id', 'is', null)
    .not('lead_id', 'is', null)
  if (from) qConv.gte('started_at', from)
  if (to)   qConv.lte('started_at', to)
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

  // ── 3. Llamadas agendadas en el rango ──
  const qAgend = supabase
    .from('llamadas')
    .select('id', { count: 'exact', head: true })
    .not('scheduled_at', 'is', null)
  if (from) qAgend.gte('scheduled_at', from)
  if (to)   qAgend.lte('scheduled_at', to)
  const { count: llamadasAgendadas } = await qAgend

  // ── 4. Conversiones manuales (sin Dapta) ──
  const qLeadsCerrados = supabase
    .from('leads')
    .select('id, status')
    .in('status', ['convertido', 'cliente_recurrente'])
  if (from) qLeadsCerrados.gte('status_changed_at', from)
  if (to)   qLeadsCerrados.lte('status_changed_at', to)
  const { data: leadsCerrados } = await qLeadsCerrados
  let conversionesManuales = 0
  if (leadsCerrados && leadsCerrados.length > 0) {
    const ids = (leadsCerrados as Array<{ id: string }>).map(l => l.id)
    const { data: llamadasOfClosed } = await supabase
      .from('llamadas')
      .select('lead_id')
      .in('lead_id', ids)
      .not('dapta_call_id', 'is', null)
    const conDapta = new Set<string>(
      ((llamadasOfClosed ?? []) as Array<{ lead_id: string }>).map(l => l.lead_id),
    )
    conversionesManuales = ids.filter(id => !conDapta.has(id)).length
  }

  // ── 5. Vambe outbound mensajes enviados ──
  const qMsgs = supabase
    .from('lead_actividad')
    .select('id', { count: 'exact', head: true })
    .eq('tipo', 'template_sent')
  if (from) qMsgs.gte('created_at', from)
  if (to)   qMsgs.lte('created_at', to)
  const { count: vambeOutboundMsgs } = await qMsgs

  // ── 6 & 7. Outbound funnel (pidió llamada / convirtieron) ──
  const qOutboundActs = supabase
    .from('lead_actividad')
    .select('lead_id')
    .eq('tipo', 'template_sent')
    .not('lead_id', 'is', null)
  if (from) qOutboundActs.gte('created_at', from)
  if (to)   qOutboundActs.lte('created_at', to)
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

  return NextResponse.json({
    dapta_exitosas: daptaExitosas ?? 0,
    dapta_convertidas: daptaConvertidas,
    llamadas_agendadas: llamadasAgendadas ?? 0,
    conversiones_manuales: conversionesManuales,
    vambe_outbound_msgs: vambeOutboundMsgs ?? 0,
    outbound_pidio_llamada: outboundPidioLlamada,
    outbound_convertidos: outboundConvertidos,
    outbound_total_leads_unicos: outboundLeadIds.length,
  })
}
