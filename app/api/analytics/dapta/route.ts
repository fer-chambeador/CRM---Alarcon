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

  // ── 2. Funnel Dapta completo: exitosa → presentación/pago → convertido ──
  // Tomamos las llamadas Dapta EXITOSAS (completed, ≥3min) en el rango y
  // medimos a qué stage llegó cada lead único. Esto nos da el funnel real
  // del flow Dapta: cuántos pasaron de "Daniela los llamó OK" a "Fer mandó
  // info" y finalmente a "pagaron".
  let qConv = supabase
    .from('llamadas')
    .select('lead_id, outcome, leads:lead_id ( status, monto )')
    .not('dapta_call_id', 'is', null)
    .eq('status', 'completed')
    .gte('duration_seconds', 180)
    .not('lead_id', 'is', null)
  if (from) qConv = qConv.gte('created_at', from)
  qConv = qConv.lte('created_at', to)
  const { data: convRows } = await qConv
  const rows = (convRows ?? []) as Array<{
    lead_id: string | null
    outcome: string | null
    leads: { status?: string; monto?: number } | { status?: string; monto?: number }[] | null
  }>
  const exitosaLeadIds = new Set<string>()
  const presentacionOrPagoIds = new Set<string>()
  const convertedLeadIds = new Set<string>()
  const pidio_presentacion_set = new Set<string>()
  const pidio_link_pago_set = new Set<string>()
  let totalVendidoDapta = 0
  // Stages "post-llamada" — el lead ya pasó del momento de la llamada
  const POST_PRES = new Set(['presentacion_enviada', 'espera_aprobacion', 'liga_pago_enviada', 'convertido', 'cliente_recurrente'])
  const CERRADOS = new Set(['convertido', 'cliente_recurrente'])
  for (const r of rows) {
    if (!r.lead_id) continue
    exitosaLeadIds.add(r.lead_id)
    const leadsField = r.leads
    const leadObj = Array.isArray(leadsField) ? leadsField[0] : leadsField
    const s = leadObj?.status
    if (s && POST_PRES.has(s)) presentacionOrPagoIds.add(r.lead_id)
    if (s && CERRADOS.has(s)) {
      convertedLeadIds.add(r.lead_id)
      // Sumar el monto del lead convertido (preferir monto registrado)
      totalVendidoDapta += Number(leadObj?.monto) || 0
    }
    if (r.outcome === 'pidio_presentacion') pidio_presentacion_set.add(r.lead_id)
    if (r.outcome === 'pidio_link_pago')    pidio_link_pago_set.add(r.lead_id)
  }
  const daptaExitosaLeadsUnicos = exitosaLeadIds.size
  const daptaAPresentacion = presentacionOrPagoIds.size
  const daptaConvertidas = convertedLeadIds.size
  const daptaPidioPresentacion = pidio_presentacion_set.size
  const daptaPidioLigaPago = pidio_link_pago_set.size

  // ── 2.B. Total créditos gastados en Dapta.
  // Como la columna `creditos` no se guarda en `llamadas`, lo estimamos por
  // duración: empíricamente Dapta cobra ~6 créditos/segundo (~360/min).
  // Ratio Dapta: 1100 créditos = $1 USD.
  let qDur = supabase
    .from('llamadas')
    .select('duration_seconds')
    .not('dapta_call_id', 'is', null)
  if (from) qDur = qDur.gte('created_at', from)
  qDur = qDur.lte('created_at', to)
  const { data: durRows } = await qDur
  const totalSec = ((durRows ?? []) as Array<{ duration_seconds?: number }>)
    .reduce((a, r) => a + (Number(r.duration_seconds) || 0), 0)
  const CRED_POR_SEGUNDO = 6
  const totalCreditos = Math.round(totalSec * CRED_POR_SEGUNDO)
  const totalGastadoUsd = totalCreditos / 1100
  const totalGastadoMxn = totalGastadoUsd * 17  // ~17 MXN/USD aprox

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
  // FIX (9-jun-2026, Fer): antes solo contábamos `template_sent` (los disparados
  // por el botón "Mensaje" de la tabla). Faltaba `reactivate_3d_sent` (los del
  // nuevo botón "Reactivar Vambe >3d" con la plantilla aprobada por Meta).
  // Ambos son envíos outbound de Vambe — los contamos juntos.
  const OUTBOUND_TIPOS = ['template_sent', 'reactivate_3d_sent']
  let qMsgs = supabase
    .from('lead_actividad')
    .select('id', { count: 'exact', head: true })
    .in('tipo', OUTBOUND_TIPOS)
  if (from) qMsgs = qMsgs.gte('created_at', from)
  qMsgs = qMsgs.lte('created_at', to)
  const { count: vambeOutboundMsgs } = await qMsgs

  // ── 6 & 7. Outbound funnel ──
  let qOutboundActs = supabase
    .from('lead_actividad')
    .select('lead_id')
    .in('tipo', OUTBOUND_TIPOS)
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
    // FIX (9-jun-2026, Fer): cuando outboundLeadIds creció a >~400 con el fix
    // de contar reactivate_3d_sent, el .in('id', [...UUIDs]) excedía el
    // límite de tamaño de URL de Supabase (~16KB) y devolvía null silencioso
    // → los counters se quedaban en 0 (de ahí el "0 pidieron llamada / 0
    // convertidos" aunque la DB sí tenía 46 y 9). Solución: chunking de 100
    // ids por query y concatenar resultados.
    const CHUNK_SIZE = 100
    const allLeads: Array<{ id: string; status: string }> = []
    for (let i = 0; i < outboundLeadIds.length; i += CHUNK_SIZE) {
      const chunk = outboundLeadIds.slice(i, i + CHUNK_SIZE)
      const { data: chunkData } = await supabase
        .from('leads')
        .select('id, status')
        .in('id', chunk)
      if (chunkData) allLeads.push(...(chunkData as Array<{ id: string; status: string }>))
    }
    const POST_LLAMADA = new Set([
      'llamada_agendada',
      'llamada_con_dapta',
      'no_show_llamada',
      'presentacion_enviada',
      'espera_aprobacion',
      'liga_pago_enviada',
      'convertido',
      'cliente_recurrente',
    ])
    const CERRADOS = new Set(['convertido', 'cliente_recurrente'])
    for (const l of allLeads) {
      if (POST_LLAMADA.has(l.status)) outboundPidioLlamada++
      if (CERRADOS.has(l.status))     outboundConvertidos++
    }
  }

  const res = NextResponse.json({
    dapta_exitosas: daptaExitosas ?? 0,
    dapta_convertidas: daptaConvertidas,
    llamadas_agendadas: llamadasAgendadas ?? 0,
    llamadas_manuales: llamadasManuales,
    conversiones_manuales: llamadasManuales,
    // Funnel Dapta completo (leads únicos que tuvieron llamada exitosa Dapta)
    dapta_exitosa_leads: daptaExitosaLeadsUnicos,
    dapta_a_presentacion: daptaAPresentacion,
    // Desglose por outcome (NUEVO — pidió por Fer 5-jun-2026)
    dapta_pidio_presentacion: daptaPidioPresentacion,
    dapta_pidio_link_pago: daptaPidioLigaPago,
    // Créditos y monetización Dapta
    total_creditos: totalCreditos,
    total_gastado_usd: Number(totalGastadoUsd.toFixed(2)),
    total_gastado_mxn: Number(totalGastadoMxn.toFixed(2)),
    total_vendido_dapta: Number(totalVendidoDapta.toFixed(2)),
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
