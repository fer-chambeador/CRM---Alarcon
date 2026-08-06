import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { isMetaCapiConfigured, sendScheduleEvent } from '@/lib/metaCapi'
import { captureMessage } from '@/lib/errorTracking'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/cron/meta-capi?secret=<META_CAPI_CRON_SECRET>
 *
 * Sweep cada 10 min: manda el evento "Schedule" a Meta CAPI por cada lead
 * que llegó a `llamada_agendada` y aún no tiene evento enviado
 * (meta_capi_schedule_sent_at IS NULL).
 *
 * Este cron es el punto de enganche ÚNICO — no hay llamadas inline en los
 * sitios que escriben el status (PATCH UI, webhook Vambe, GCal import,
 * etiquetas WA, MCP, bot...): cualquier camino presente o futuro queda
 * cubierto por el barrido. Ventana de 7 días = límite de event_time de Meta;
 * también evita disparar leads históricos en el primer deploy.
 *
 * El evento se manda UNA sola vez por lead: la marca sobrevive el rebote
 * cancelación → contactado → re-agendada (no se re-envía).
 *
 * Setup:
 *   1. Env var META_CAPI_CRON_SECRET en el web service (openssl rand -hex 32).
 *   2. Scheduler externo (Railway cron service / Cloud Scheduler / cron-job.org):
 *      schedule: *\/10 * * * *
 *      curl -fsS -H "x-cron-secret: $META_CAPI_CRON_SECRET" https://<host>/api/cron/meta-capi
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || req.headers.get('x-cron-secret')
  // Secret DEDICADO de este cron (META_CAPI_CRON_SECRET): independiente del
  // secret compartido de los otros crons — rotarlo no afecta a nadie más y
  // viceversa. Fallback a los compartidos por consistencia con el resto.
  const expected = process.env.META_CAPI_CRON_SECRET
    || process.env.CRON_SECRET
    || process.env.DAPTA_POST_CALL_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (!isMetaCapiConfigured()) {
    return NextResponse.json({
      ok: true,
      skipped: 'meta-capi-not-configured',
      timestamp: new Date().toISOString(),
    })
  }

  const supabase = createServiceClient()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()

  // coalesce(status_changed_at, created_at) >= hace 7 días, expresado en
  // sintaxis .or() de PostgREST (no soporta coalesce en filtros).
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('status', 'llamada_agendada')
    .is('meta_capi_schedule_sent_at', null)
    .or(`status_changed_at.gte.${sevenDaysAgo},and(status_changed_at.is.null,created_at.gte.${sevenDaysAgo})`)
    .order('status_changed_at', { ascending: true, nullsFirst: true })
    .limit(50)

  if (error) {
    console.error('[meta-capi] query error', error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const leads = (data || []) as Lead[]
  let sent = 0
  let failed = 0
  let skipped = 0
  const failures: Array<{ lead_id: string; error: string }> = []

  for (const lead of leads) {
    const result = await sendScheduleEvent(lead)

    if (result.ok) {
      sent++
      // Marcar DESPUÉS del envío exitoso. Si dos corridas se solaparan, el
      // event_id determinístico (schedule-<lead.id>) hace que Meta deduplique.
      await supabase.from('leads')
        .update({ meta_capi_schedule_sent_at: new Date().toISOString() })
        .eq('id', lead.id)
      await supabase.from('lead_actividad').insert({
        lead_id: lead.id,
        tipo: 'meta_capi_event',
        descripcion: '📡 Evento Schedule enviado a Meta CAPI',
        metadata: {
          event_id: `schedule-${lead.id}`,
          action_source: lead.ctwa_clid ? 'business_messaging' : 'system_generated',
          fbtrace_id: result.fbtrace_id,
          events_received: result.events_received,
        },
      })
    } else if (result.unmatchable) {
      // Sin email/teléfono utilizables — nunca va a matchear. Se marca como
      // enviado para que el sweep no lo reintente eternamente.
      skipped++
      await supabase.from('leads')
        .update({ meta_capi_schedule_sent_at: new Date().toISOString() })
        .eq('id', lead.id)
      await supabase.from('lead_actividad').insert({
        lead_id: lead.id,
        tipo: 'meta_capi_skip',
        descripcion: '📡 Schedule NO enviado a Meta — sin email/teléfono matcheable',
        metadata: { reason: result.error },
      })
    } else {
      // Error transitorio (Meta caído, token vencido...) — sin marca ni
      // actividad: reintenta en la siguiente corrida sin ensuciar la timeline.
      failed++
      failures.push({ lead_id: lead.id, error: result.error })
      console.error('[meta-capi] fallo enviando Schedule', { lead_id: lead.id, error: result.error })
    }
  }

  if (failed > 0) {
    captureMessage(`meta-capi: ${failed} evento(s) Schedule fallaron`, 'warning', {
      failures: failures.slice(0, 5),
    })
  }
  if (sent > 0 || failed > 0 || skipped > 0) {
    console.log('[meta-capi] result', { scanned: leads.length, sent, failed, skipped })
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    scanned: leads.length,
    sent,
    failed,
    skipped,
  })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
