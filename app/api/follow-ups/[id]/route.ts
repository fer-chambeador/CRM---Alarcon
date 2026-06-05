import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

/**
 * PATCH /api/follow-ups/[id]  { titulo?, notas?, fecha?, tipo?, completado? }
 * DELETE /api/follow-ups/[id]
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIPO_OK = new Set(['llamada', 'mensaje', 'pago', 'presentacion', 'general'])

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'id no es UUID válido' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'body inválido' }, { status: 400 })

  const supabase = createServiceClient()
  const updates: Record<string, unknown> = {}
  if (typeof body.titulo === 'string') updates.titulo = body.titulo.slice(0, 500)
  if (typeof body.notas === 'string') updates.notas = body.notas.slice(0, 5000)
  if (body.notas === null) updates.notas = null
  if (body.fecha) {
    const d = new Date(body.fecha)
    if (isNaN(d.getTime())) return NextResponse.json({ error: 'fecha inválida' }, { status: 400 })
    updates.fecha = d.toISOString()
  }
  if (body.tipo) {
    if (!TIPO_OK.has(body.tipo)) return NextResponse.json({ error: 'tipo inválido' }, { status: 400 })
    updates.tipo = body.tipo
  }
  if (typeof body.completado === 'boolean') {
    updates.completado = body.completado
    updates.completado_at = body.completado ? new Date().toISOString() : null
  }
  if (body.lead_id !== undefined) {
    if (body.lead_id !== null && !UUID_RE.test(String(body.lead_id))) {
      return NextResponse.json({ error: 'lead_id no es UUID válido' }, { status: 400 })
    }
    updates.lead_id = body.lead_id
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'no hay campos para actualizar' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('follow_ups')
    .update(updates)
    .eq('id', id)
    .select()
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'follow_up no encontrado' }, { status: 404 })
  return NextResponse.json({ follow_up: data })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'id no es UUID válido' }, { status: 400 })
  const supabase = createServiceClient()
  const { error } = await supabase.from('follow_ups').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
