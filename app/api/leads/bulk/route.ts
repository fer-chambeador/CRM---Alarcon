import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

const ALLOWED_FIELDS = ['status', 'plan', 'canal_adquisicion', 'puesto'] as const
type AllowedField = typeof ALLOWED_FIELDS[number]

export async function PATCH(req: NextRequest) {
  const supabase = createServiceClient()
  const body = await req.json()
  const ids: string[] = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === 'string') : []
  const rawUpdates = body?.updates && typeof body.updates === 'object' ? body.updates : {}

  if (!ids.length) return NextResponse.json({ error: 'ids requerido' }, { status: 400 })

  const updates: Record<string, unknown> = {}
  for (const k of ALLOWED_FIELDS) {
    if (k in rawUpdates) updates[k] = rawUpdates[k as AllowedField]
  }
  if (!Object.keys(updates).length) return NextResponse.json({ error: 'sin campos válidos para actualizar' }, { status: 400 })

  const { data, error } = await supabase
    .from('leads')
    .update(updates)
    .in('id', ids)
    .select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Activity log per lead when status changed
  if ('status' in updates && data) {
    const rows = data.map(l => ({
      lead_id: l.id,
      tipo: 'status_change',
      descripcion: `Status cambiado a: ${updates.status} (bulk)`,
      metadata: updates,
    }))
    if (rows.length) await supabase.from('lead_actividad').insert(rows)
  }

  return NextResponse.json({ updated: data?.length || 0, leads: data })
}
