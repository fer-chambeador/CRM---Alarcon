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
 *   3. llamadas_agendadas     — llamadas con scheduled_at en el rango (futuras o
 *                              ya disparadas; el "agendamiento" sucedió en el mes)
 *   4. conversiones_manuales  — leads cerrados SIN haber pasado por Dapta
 *                              (yo, manual, sin máquina)
 *   5. vambe_outbound_msgs    — count de lead_actividad tipo='template_sent'
 *   6. outbound_pidio_llamada — leads únicos con template_sent que luego escalaron
 *                              a llamada_agendada o más adelante en el funnel
 *   7. outbound_convertidos   — leads únicos con template_sent que cerraron
 *
 * Si se pasa from/to filtra por created_at del lead/llamada/actividad según
 * aplique. Sin filtros, todo el histórico.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')

  const supabase = createServiceClient()

  // Helper: aplica filtros de fecha si vienen
  function applyDateFilter<T extends { gte: (col: string, v: string) => T; lte: (col: string, v: string) => T }>(
    q: T,
    col: string,
  ): T {
    let out = q
    if (from) out = out.gte(col, from)
    if (to)   out = out.lte(col, to)
    return out
  }

  // ── 1. Dapta llamadas exitosas (>= 3 min) ──
  // Usamos count: 'exact' + head:true para solo traer el count
  let qExit = supabase
    .from('llamadas')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed')
    .gte('duration_seconds', 180)
  qExit = applyDateFilter(qExit, 'started_at')
  const { count: daptaExitosas } = await qExit

  // ── 2. Dapta llamadas convertidas ──
  // Leads únicos que recibieron una llamada (dapta_call_id NOT NULL) Y su
  // lead.status quedó en convertido / cliente_recurrente.
  let qConv = supabase
    .from('llamadas')
    .select('lead_id, leads:lead_id ( status )')
    .not('dapta_call_id', 'is', null)
    .not('lead_id', 'is', null)
  qConv = applyDateFilter(qConv, 'started_at')
  const { data: convRows } = await qConv
  const daptaConvertidas = new Set(
    (convRows || [])
      .filter((r: { lead_id: string | null; leads: { status?: string } | { status?: string }[] | null }) => {
        const leadsField = r.leads as { status?: string } | { status?: string }[] | null
        const s = Array.isArray(leadsField) ? leadsField[0]?.status : leadsField?.status
        return s === 'convertido' || s === 'cliente_recurrente'
      })
      .map((r: { lead_id: string | null }) => r.lead_id),
  ).size

  // ── 3. Llamadas agendadas en el rango ──
  let qAgend = supabase
    .from('llamadas')
    .select('id', { count: 'exact', head: true })
    .not('scheduled_at', 'is', null)
  if (from) qAgend = qAgend.gte('scheduled_at', from)
  if (to)   qAgend = qAgend.lte('scheduled_at', to)
  const { count: llamadasAgendadas } = await qAgend

  // ── 4. Conversiones manuales (sin Dapta) ──
  // Leads cerrados QUE NO tienen llamada Dapta asociada
  let qLeadsCerrados = supabase
    .from('leads')
    .select('id, status')
    .in('status', ['convertido', 'cliente_recurrente'])
  qLeadsCerrados = applyDateFilter(qLeadsCerrados, 'status_changed_at')
  const { data: leadsCerrados } = await qLeadsCerrados
  let conversionesManuales = 0
  if (leadsCerrados && leadsCerrados.length > 0) {
    const ids = (leadsCerrados as { id: string }[]).map(l => l.id)
    // Buscar cuáles tienen llamada Dapta (dapta_call_id IS NOT NULL)
    const { data: llamadasOfClosed } = await supabase
      .from('llamadas')
      .select('lead_id')
      .in('lead_id', ids)
      .not('dapta_call_id', 'is', null)
    const conDapta = new Set((llamadasOfClosed || []).map((l: { lead_id: string }) => l.lead_id))
    conversionesManuales = ids.filter(id => !conDapta.has(id)).length
  }

  // ── 5. Vambe outbound mensajes enviados ──
  let qMsgs = supabase
    .from('lead_actividad')
    .select('id', { count: 'exact', head: true })
    .eq('tipo', 'template_sent')
  qMsgs = applyDateFilter(qMsgs, 'created_at')
  const { count: vambeOutboundMsgs } = await qMsgs

  // ── 6. Outbound leads que pidieron llamada ──
  // Leads únicos que recibieron template_sent y luego están en
  // llamada_agendada / llamada_con_dapta / no_show_llamada / presentacion / espera / convertido / cliente_recurrente.
  // (cualquier stage posterior al outbound)
  let qOutboundLeads = supabase
    .from('lead_actividad')
    .select('lead_id')
    .eq('tipo', 'template_sent')
    .not('lead_id', 'is', null)
  qOutboundLeads = applyDateFilter(qOutboundLeads, 'created_at')
  const { data: outboundActs } = await qOutboundLeads
  const outboundLeadIds = Array.from(new Set((outboundActs || []).map((r: { lead_id: string }) => r.lead_id)))

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
    for (const l of (outboundLeadsData || []) as { id: string; status: string }[]) {
      if (POST_LLAMADA.has(l.status)) outboundPidioLlamada++
      if (CERRADOS.has(l.status))     outboundConvertidos++
    }
  }

  return NextResponse.json({
    dapta_exitosas: daptaExitosas || 0,
    dapta_convertidas: daptaConvertidas,
    llamadas_agendadas: llamadasAgendadas || 0,
    conversiones_manuales: conversionesManuales,
    vambe_outbound_msgs: vambeOutboundMsgs || 0,
    outbound_pidio_llamada: outboundPidioLlamada,
    outbound_convertidos: outboundConvertidos,
    outbound_total_leads_unicos: outboundLeadIds.length,
  })
}
