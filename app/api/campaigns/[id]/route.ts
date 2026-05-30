import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/campaigns/[id]
 *
 * Detalle de una campaña incluyendo todos sus recipients (con outcomes).
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()

  const { data: campaign, error: cErr } = await supabase
    .from('vambe_campaigns')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
  if (!campaign) return NextResponse.json({ error: 'campaign no encontrada' }, { status: 404 })

  const { data: recipients, error: rErr } = await supabase
    .from('vambe_campaign_recipients')
    .select(`
      id, lead_id, phone, email, nombre, vars,
      sent_at, send_error, responded_at, scheduled_call_at, paid_at, created_at,
      leads (
        id, status, nombre, email, telefono, vacante, empresa, canal_adquisicion
      )
    `)
    .eq('campaign_id', params.id)
    .order('created_at', { ascending: true })
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 })

  return NextResponse.json({ campaign, recipients: recipients || [] })
}
