import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

/**
 * PATCH /api/follow-ups/[id]  { titulo?, notas?, fecha?, tipo?, completado? }
 * DELETE /api/follow-ups/[id]
 */

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'body inválido' }, { status: 400 })

  const supabase = createServiceClient()
  const updates: Record<string, unknown> = {}
  if (typeof body.titulo === 'string') updates.titulo = body.titulo.slice(0, 500)
  if (typeof body.notas === 'string') updates.notas = body.notas.slice(0, 5000)
  if (body.notas === null) updates.notas = null
  if (body.fecha) updates.fecha = body.fecha
  if (body.tipo) updates.tipo = body.tipo
  if (typeof body.completado === 'boolean') {
    updates.completado = body.completado
    updates.completado_at = body.completado ? new Date().toISOString() : null
  }
  if (body.lead_id !== undefined) updates.lead_id = body.lead_id

  const { data, error } = await supabase
    .from('follow_ups')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ follow_up: data })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const { error } = await supabase.from('follow_ups').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
