import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * POST /api/aprobaciones/[id]/reject
 *
 * Marca la aprobación como rejected_manual. NO se vuelve a sugerir
 * (el cron no recreará una pending para este lead+tipo).
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()

  const { data: apro } = await supabase
    .from('aprobaciones')
    .select('id, lead_id, tipo, status')
    .eq('id', params.id)
    .maybeSingle()
  if (!apro) return NextResponse.json({ error: 'aprobación no encontrada' }, { status: 404 })
  if ((apro as { status: string }).status !== 'pending') {
    return NextResponse.json({ ok: false, error: `aprobación ya está en estado '${(apro as { status: string }).status}'` })
  }

  const { error } = await supabase
    .from('aprobaciones')
    .update({
      status: 'rejected_manual',
      decided_at: new Date().toISOString(),
    })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const a = apro as { id: string; lead_id: string; tipo: string }
  await supabase.from('lead_actividad').insert({
    lead_id: a.lead_id,
    tipo: 'aprobacion_rejected',
    descripcion: a.tipo === 'vambe_template'
      ? '⛔ Decidiste mandar mensaje manual (no Vambe outbound)'
      : '⛔ Decidiste llamar manual (no Dapta)',
    metadata: { source: 'aprobacion', aprobacion_id: a.id, tipo: a.tipo },
  })

  return NextResponse.json({ ok: true })
}
