import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/atencion/[id]/attend?via=slack
 *
 * Marca un ticket de Atención Humana como atendido. Llamado desde el botón
 * "✓ Sí, atendido" en el mensaje de Slack. Redirige a /leads/[lead_id] con
 * un toast "✓ Marcado como atendido".
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()

  const { data: existing } = await supabase
    .from('vambe_atencion_tickets')
    .select('id, lead_id, status')
    .eq('id', params.id)
    .maybeSingle()
  if (!existing) {
    return new NextResponse('Ticket no encontrado', { status: 404 })
  }
  const t = existing as { id: string; lead_id: string; status: string }

  if (t.status === 'pending') {
    await supabase
      .from('vambe_atencion_tickets')
      .update({
        status: 'attended',
        attended_at: new Date().toISOString(),
        attended_by: 'slack',
      })
      .eq('id', params.id)

    await supabase.from('lead_actividad').insert({
      lead_id: t.lead_id,
      tipo: 'atencion_humana_attended',
      descripcion: '✓ Asistencia humana atendida (desde Slack)',
      metadata: { source: 'slack', ticket_id: params.id },
    })
  }

  // Redirigir al detalle del lead — mejor UX que mostrar JSON
  const base = process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
  return NextResponse.redirect(`${base}/leads/${t.lead_id}?atendido=true`, { status: 302 })
}
