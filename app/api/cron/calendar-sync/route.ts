import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { importEventsToLeads, isConnected } from '@/lib/googleCalendar'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/cron/calendar-sync?secret=<DAPTA_POST_CALL_SECRET>
 *
 * Endpoint disparado por cron-job.org cada 10 min. Sincroniza próximas
 * llamadas del Google Calendar al CRM:
 *
 *  - Pull eventos relevantes (filtrados por isRelevantCalendarEvent — ver
 *    lib/googleCalendar.ts) de los próximos 30 días.
 *  - Para cada evento:
 *      · Si el email del cliente matchea un lead → actualizar llamada_at +
 *        avanzar status a 'llamada_agendada' si está en [nuevo, contactado,
 *        no_show_llamada].
 *      · Si no matchea → crear lead nuevo con canal='Calendar booking',
 *        status='llamada_agendada'.
 *      · Si ya estaba sincronizado idénticamente → skip (idempotente).
 *
 * Reusa DAPTA_POST_CALL_SECRET como secret común para cron-job.org. Si
 * algún día queremos uno separado podemos agregar CRON_SECRET adicional.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || req.headers.get('x-cron-secret')
  const expected = process.env.CRON_SECRET || process.env.DAPTA_POST_CALL_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Sanity check: que Calendar esté conectado. Si no, devolvemos OK silencioso
  // (no es error — solo no hay nada que hacer hasta que el user conecte OAuth).
  const conn = await isConnected(supabase)
  if (!conn.connected) {
    return NextResponse.json({
      ok: true,
      skipped: 'google-calendar-not-connected',
      timestamp: new Date().toISOString(),
    })
  }

  try {
    const result = await importEventsToLeads(supabase)

    // Log de la corrida en lead_actividad — pero solo si hubo trabajo real.
    // No queremos spam en la timeline cada 10 min con corridas vacías.
    if (result.leads_updated > 0 || result.leads_created > 0) {
      console.log('[calendar-sync] result', {
        scanned: result.events_scanned,
        matched: result.leads_matched,
        updated: result.leads_updated,
        created: result.leads_created,
      })
    }
    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      ...result,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[calendar-sync] error', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

/**
 * POST también soportado (por compat con el botón del UI que usa POST sin auth
 * en /api/integrations/google/import — este nuevo endpoint requiere secret).
 */
export async function POST(req: NextRequest) {
  return GET(req)
}
