import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * GET /api/cron/promote-recurrentes?secret=<CRON_SECRET|DAPTA_POST_CALL_SECRET>
 *
 * Cron mensual — corre el día 1 de cada mes a las 00:05 CDMX. Promueve a
 * 'cliente_recurrente' todos los leads que estén en 'convertido' Y que
 * tengan status_changed_at en el MES ANTERIOR.
 *
 * Lógica de la regla (Fer, 2 jun 2026):
 *   - Lead paga en mes X → status='convertido' (vía /api/slack/events).
 *   - El día 1 del mes X+1 → este cron los promueve a 'cliente_recurrente'.
 *   - Resultado: en el reporte mensual del mes X+1, los 'convertido' son los
 *     que pagaron NUEVO ese mes; los 'cliente_recurrente' son los que ya
 *     habían pagado antes (recurrentes/históricos).
 *
 * Idempotente: si se corre 2 veces el mismo día, la segunda corrida no
 * mueve nada porque ya no hay 'convertido' del mes anterior.
 *
 * Ejecución manual / forzada: pasar ?dry_run=1 para ver qué leads se
 * promoverían sin aplicar el UPDATE.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || req.headers.get('x-cron-secret')
  const expected = process.env.CRON_SECRET || process.env.DAPTA_POST_CALL_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const dryRun = url.searchParams.get('dry_run') === '1'

  const supabase = createServiceClient()

  // Calcular los bounds del MES ANTERIOR en CDMX. CDMX está en UTC-6 (sin DST
  // desde 2022). Por simplicidad usamos UTC-6 fijo. Si DST regresa, ajustar.
  // Ejemplo: si hoy es 2026-07-01 a cualquier hora, el "mes anterior" es
  // [2026-06-01 00:00 CDMX, 2026-07-01 00:00 CDMX) = [2026-06-01 06:00 UTC, 2026-07-01 06:00 UTC).
  const now = new Date()
  // Construir el primer día del mes ACTUAL en CDMX (UTC-6).
  // Tomamos el año/mes del current date en CDMX.
  const cdmxNow = new Date(now.getTime() - 6 * 60 * 60_000)
  const yearCdmx = cdmxNow.getUTCFullYear()
  const monthCdmx = cdmxNow.getUTCMonth() // 0-11
  // Primer momento del mes actual en CDMX:
  const startOfCurrentMonthUtc = Date.UTC(yearCdmx, monthCdmx, 1, 6, 0, 0) // +6h porque CDMX UTC-6
  // Primer momento del mes anterior en CDMX:
  const prevMonth = monthCdmx === 0 ? { y: yearCdmx - 1, m: 11 } : { y: yearCdmx, m: monthCdmx - 1 }
  const startOfPrevMonthUtc = Date.UTC(prevMonth.y, prevMonth.m, 1, 6, 0, 0)

  const fromIso = new Date(startOfPrevMonthUtc).toISOString()
  const toIso = new Date(startOfCurrentMonthUtc).toISOString()

  // Buscar leads convertidos del mes anterior
  const { data: candidates, error } = await supabase
    .from('leads')
    .select('id, nombre, email, empresa, status, status_changed_at, suscripcion_fecha, monto, canal_adquisicion')
    .eq('status', 'convertido')
    .gte('status_changed_at', fromIso)
    .lt('status_changed_at', toIso)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (candidates ?? []) as Array<{
    id: string; nombre: string | null; email: string | null; empresa: string | null;
    status: string; status_changed_at: string; suscripcion_fecha: string | null;
    monto: number | null; canal_adquisicion: string | null;
  }>

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      promoted: 0,
      window: { from: fromIso, to: toIso },
      message: 'Nada que promover (no hay convertidos del mes anterior).',
    })
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      would_promote: rows.length,
      window: { from: fromIso, to: toIso },
      leads: rows.map(r => ({
        id: r.id, nombre: r.nombre, email: r.email, empresa: r.empresa,
        status_changed_at: r.status_changed_at, monto: r.monto,
      })),
    })
  }

  // Promover en batch
  const ids = rows.map(r => r.id)
  const nowIso = new Date().toISOString()
  const { error: updateErr } = await supabase
    .from('leads')
    .update({ status: 'cliente_recurrente', status_changed_at: nowIso })
    .in('id', ids)
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  // Log activity por cada lead
  await supabase.from('lead_actividad').insert(
    rows.map(r => ({
      lead_id: r.id,
      tipo: 'status_change',
      descripcion: `💎 Promovido a Cliente Recurrente (cierre de mes — pago original ${new Date(r.status_changed_at).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' })})`,
      metadata: {
        source: 'promote-recurrentes-cron',
        from: 'convertido',
        to: 'cliente_recurrente',
        original_status_changed_at: r.status_changed_at,
        window_from: fromIso,
        window_to: toIso,
      },
    })),
  )

  return NextResponse.json({
    ok: true,
    promoted: rows.length,
    window: { from: fromIso, to: toIso },
    lead_ids: ids,
  })
}
