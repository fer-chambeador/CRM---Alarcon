import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const ALLOWED_STR = ['nombre', 'email', 'fecha_inicio', 'canal', 'notas'] as const
const ALLOWED_BOOL = ['hidden'] as const

export async function PATCH(req: NextRequest, { params }: { params: { key: string } }) {
  const supabase = createServiceClient()
  const body = await req.json().catch(() => ({}))
  const key = decodeURIComponent(params.key)

  const updates: Record<string, string | boolean | null> = {}
  for (const k of ALLOWED_STR) {
    if (k in body) {
      const v = body[k]
      updates[k] = (typeof v === 'string' && v.trim()) ? v.trim() : null
    }
  }
  for (const k of ALLOWED_BOOL) {
    if (k in body) updates[k] = !!body[k]
  }

  if (!Object.keys(updates).length) {
    return NextResponse.json({ error: 'sin campos para actualizar' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('clientes_recurrentes_meta')
    .upsert({ key, ...updates }, { onConflict: 'key' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, meta: data })
}

export async function DELETE(_req: NextRequest, { params }: { params: { key: string } }) {
  const supabase = createServiceClient()
  const key = decodeURIComponent(params.key)
  const { error } = await supabase
    .from('clientes_recurrentes_meta')
    .delete()
    .eq('key', key)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
