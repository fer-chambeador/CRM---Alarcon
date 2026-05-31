import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/llamadas/[id] — detalle de una llamada (con join al lead).
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('llamadas')
    .select(`
      *,
      leads:lead_id ( id, nombre, email, empresa, telefono, status, presupuesto, vacante, notas, canal_adquisicion )
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'no encontrada' }, { status: 404 })
  return NextResponse.json(data)
}

/**
 * PATCH /api/llamadas/[id]
 *
 * Body: { status?: 'canceled', notas?: string, scheduled_at?: string }
 *
 * Por ahora soporta cancelar una llamada agendada o reagendarla. Solo aplica a
 * filas que aún no se hayan disparado (dapta_call_id IS NULL).
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => null) as {
    status?: 'canceled'
    scheduled_at?: string
  } | null
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const supabase = createServiceClient()
  const { data: existing } = await supabase
    .from('llamadas')
    .select('id, status, scheduled_at, dapta_call_id, lead_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'no encontrada' }, { status: 404 })

  if ((existing as { dapta_call_id?: string | null }).dapta_call_id) {
    return NextResponse.json({ error: 'la llamada ya se disparó — no se puede modificar' }, { status: 400 })
  }

  const updates: Record<string, unknown> = {}
  if (body.status === 'canceled') updates.status = 'canceled'
  if (body.scheduled_at) {
    const d = new Date(body.scheduled_at)
    if (isNaN(d.getTime())) return NextResponse.json({ error: 'scheduled_at inválido' }, { status: 400 })
    updates.scheduled_at = d.toISOString()
  }
  if (Object.keys(updates).length === 0) return NextResponse.json({ error: 'nada que actualizar' }, { status: 400 })

  const { data: updated, error } = await supabase
    .from('llamadas')
    .update(updates)
    .eq('id', params.id)
    .select('*')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Log actividad
  const leadId = (existing as { lead_id?: string | null }).lead_id
  if (leadId && body.status === 'canceled') {
    await supabase.from('lead_actividad').insert({
      lead_id: leadId,
      tipo: 'dapta_call_canceled',
      descripcion: '❌ Llamada Dapta agendada cancelada',
      metadata: { source: 'manual', llamada_id: params.id },
    })
  }
  return NextResponse.json(updated)
}
