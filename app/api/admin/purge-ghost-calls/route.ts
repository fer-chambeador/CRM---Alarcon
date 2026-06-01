/**
 * POST /api/admin/purge-ghost-calls?secret=admin_purge_ghosts_2026
 *
 * Borra (hard delete) las llamadas "fantasma" — filas en `llamadas` que se
 * crearon vía post-call pero quedaron sin lead_id, sin to_number y sin
 * dapta_call_id, así que no representan nada útil y ensucian la UI.
 *
 * GET lista (dry-run), POST hace el delete.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const SECRET = 'admin_purge_ghosts_2026'

async function findGhosts() {
  const supabase = createServiceClient()
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('llamadas')
    .select('id, status, to_number, lead_id, dapta_call_id, created_at')
    .is('lead_id', null)
    .is('to_number', null)
    .is('dapta_call_id', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200)
  return { data: data || [], error }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  if (url.searchParams.get('secret') !== SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { data, error } = await findGhosts()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ dry_run: true, count: data.length, ghosts: data })
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  if (url.searchParams.get('secret') !== SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { data: ghosts, error } = await findGhosts()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (ghosts.length === 0) return NextResponse.json({ ok: true, deleted: 0, ids: [] })

  const supabase = createServiceClient()
  const ids = ghosts.map(g => (g as { id: string }).id)
  const { error: delErr } = await supabase.from('llamadas').delete().in('id', ids)
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
  return NextResponse.json({ ok: true, deleted: ids.length, ids })
}
