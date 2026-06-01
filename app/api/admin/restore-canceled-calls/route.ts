/**
 * POST /api/admin/restore-canceled-calls?secret=admin_restore_calls_2026
 *
 * Body: { ids: string[] }
 *
 * Toma una lista de llamada IDs que están en status='canceled' (porque las
 * canceló erróneamente force-cancel-orphan-calls) y las regresa a 'dialing'
 * limpiando error_message para que el próximo post-call de Dapta las pueda
 * matchear y completar correctamente.
 *
 * Solo afecta filas con status='canceled' AND dapta_call_id IS NULL.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const SECRET = 'admin_restore_calls_2026'

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  if (url.searchParams.get('secret') !== SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => null) as { ids?: string[] } | null
  if (!body?.ids?.length) {
    return NextResponse.json({ error: 'ids[] requerido' }, { status: 400 })
  }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('llamadas')
    .update({ status: 'dialing', error_message: null })
    .in('id', body.ids)
    .eq('status', 'canceled')
    .is('dapta_call_id', null)
    .select('id, status, lead_id, to_number')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, restored: (data || []).length, rows: data })
}
