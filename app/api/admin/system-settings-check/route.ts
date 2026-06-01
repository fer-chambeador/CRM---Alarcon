/**
 * GET /api/admin/system-settings-check?secret=<DAPTA_POST_CALL_SECRET>
 *
 * Lista (sin revelar valores secretos) qué keys hay en system_settings table.
 * Útil para verificar que `slack_alertas_vambe_webhook` esté guardado.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const expected = process.env.CRON_SECRET || process.env.DAPTA_POST_CALL_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('system_settings')
    .select('key, updated_at, value')
    .order('key', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // Mascarar valores sensibles
  const summary = (data || []).map((row: { key: string; updated_at: string; value: unknown }) => {
    const v = row.value
    let preview = ''
    let type = typeof v
    let length = 0
    if (typeof v === 'string') {
      length = v.length
      preview = v.slice(0, 20) + (v.length > 20 ? '…' : '')
    } else if (v && typeof v === 'object') {
      const s = JSON.stringify(v)
      length = s.length
      preview = s.slice(0, 60) + (s.length > 60 ? '…' : '')
    }
    return { key: row.key, type, length, preview, updated_at: row.updated_at }
  })
  return NextResponse.json({ count: summary.length, settings: summary })
}
