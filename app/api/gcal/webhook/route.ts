import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { importEventsToLeads, reconcileCancelledCalls, gcalWebhookToken } from '@/lib/googleCalendar'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/gcal/webhook — receptor de push notifications de Google Calendar.
 *
 * Google manda un POST (sin body útil) cada vez que un evento del calendario
 * cambia: creado, movido, editado o cancelado. Headers relevantes:
 *   - x-goog-channel-token:   el token que registramos en events.watch (auth)
 *   - x-goog-resource-state:  'sync' (saludo inicial) | 'exists' (hubo cambio)
 *   - x-goog-channel-id / x-goog-resource-id: identifican el canal
 *
 * Al recibir un cambio corremos el MISMO pipeline que el cron:
 *   importEventsToLeads  → llamadas nuevas/movidas quedan en el CRM
 *   reconcileCancelledCalls → llamadas canceladas revierten el lead
 *
 * El resultado: calendario y CRM sincronizados segundos después de que Vambe
 * (o Fer a mano) agende, mueva o cancele una llamada. El cron de cada 10 min
 * queda como fallback por si un push se pierde.
 */
export async function POST(req: NextRequest) {
  // Auth: el token viaja en el header que Google reenvía tal cual.
  const expected = gcalWebhookToken()
  const provided = req.headers.get('x-goog-channel-token') || ''
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const state = req.headers.get('x-goog-resource-state') || ''

  // 'sync' = mensaje de bienvenida al crear el canal — ack y nada más.
  if (state === 'sync') {
    return NextResponse.json({ ok: true, state: 'sync' })
  }

  const supabase = createServiceClient()
  try {
    const imported = await importEventsToLeads(supabase)
    const reconciled = await reconcileCancelledCalls(supabase)
    console.log('[gcal-webhook]', {
      state,
      scanned: imported.events_scanned,
      updated: imported.leads_updated,
      created: imported.leads_created,
      reverted: reconciled.reverted.length,
    })
    return NextResponse.json({
      ok: true,
      state,
      import: {
        events_scanned: imported.events_scanned,
        leads_updated: imported.leads_updated,
        leads_created: imported.leads_created,
      },
      reconcile: {
        checked: reconciled.checked,
        reverted: reconciled.reverted.length,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[gcal-webhook] error', msg)
    // 200 igual — si devolvemos 5xx repetidamente Google puede pausar el canal.
    return NextResponse.json({ ok: false, error: msg })
  }
}

/** GET para debug rápido en el browser (no expone nada sensible). */
export async function GET() {
  return NextResponse.json({
    ok: true,
    info: 'Receptor de Google Calendar push. Google manda POST con x-goog-channel-token.',
  })
}
