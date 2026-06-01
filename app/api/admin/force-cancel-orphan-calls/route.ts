/**
 * GET/POST /api/admin/force-cancel-orphan-calls?secret=admin_force_cancel_2026
 *
 * Cancela TODAS las llamadas en estado 'queued' o 'dialing' que llevan más de
 * 5 minutos sin progresar. Útil para parar bucles de cron-trigger que disparan
 * Dapta repetidamente cuando el post-call no logra cerrar la fila original.
 *
 * Devuelve la lista de filas afectadas. POST hace el cambio, GET es dry-run.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const SECRET = 'admin_force_cancel_2026'

async function findOrphans() {
  const supabase = createServiceClient()
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('llamadas')
    .select('id, lead_id, status, to_number, scheduled_at, created_at, dapta_call_id')
    .in('status', ['queued', 'dialing'])
    .lt('created_at', fiveMinAgo)
    .order('created_at', { ascending: false })
    .limit(200)
  return { data: data || [], error }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  if (url.searchParams.get('secret') !== SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { data, error } = await findOrphans()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ dry_run: true, count: data.length, orphans: data })
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  if (url.searchParams.get('secret') !== SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { data: orphans, error } = await findOrphans()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (orphans.length === 0) return NextResponse.json({ ok: true, canceled: 0, ids: [] })

  const supabase = createServiceClient()
  const ids = orphans.map(o => (o as { id: string }).id)
  const { error: updErr } = await supabase
    .from('llamadas')
    .update({
      status: 'canceled',
      error_message: 'force-canceled — orphan queued/dialing >5min (cron bucle prevention)',
    })
    .in('id', ids)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, canceled: ids.length, ids })
}
