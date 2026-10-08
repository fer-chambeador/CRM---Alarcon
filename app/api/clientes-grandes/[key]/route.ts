import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const EDITABLES = ['empresa', 'contacto_nombre', 'contacto_puesto', 'telefono', 'email', 'owner', 'plan', 'proxima_accion', 'proxima_accion_fecha', 'ultimo_contacto', 'notas', 'salud', 'renueva_manual'] as const

/** PATCH /api/clientes-grandes/[key] — editar owner / próxima acción / datos (upsert sobre la fila del sheet). */
export async function PATCH(req: NextRequest, { params }: { params: { key: string } }) {
  const key = decodeURIComponent(params.key).toLowerCase()
  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = { cliente_key: key, updated_at: new Date().toISOString() }
  for (const f of EDITABLES) if (f in body) updates[f] = body[f] === '' ? null : body[f]
  if (!key.startsWith('manual:') && !('origen' in updates)) updates.origen = 'sheet'
  const supabase = createServiceClient()
  const { data: prev } = await supabase.from('clientes_grandes').select('origen').eq('cliente_key', key).maybeSingle()
  if (prev) delete updates.origen
  const { data, error } = await supabase.from('clientes_grandes').upsert(updates, { onConflict: 'cliente_key' }).select().single()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, cliente: data })
}

/**
 * DELETE /api/clientes-grandes/[key] — quitar de la lista.
 * Soft delete (eliminado=true): si se borrara la fila, el sheet lo volvería a meter.
 */
export async function DELETE(_req: NextRequest, { params }: { params: { key: string } }) {
  const key = decodeURIComponent(params.key).toLowerCase()
  const supabase = createServiceClient()
  const { data: prev } = await supabase.from('clientes_grandes').select('id').eq('cliente_key', key).maybeSingle()
  const row: Record<string, unknown> = { cliente_key: key, eliminado: true, updated_at: new Date().toISOString() }
  if (!prev) row.origen = key.startsWith('manual:') ? 'manual' : 'sheet'
  const { error } = await supabase.from('clientes_grandes').upsert(row, { onConflict: 'cliente_key' })
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
