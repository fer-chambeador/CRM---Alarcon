import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { requireBotAuth } from '../../_lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bot/leads/[id]
 *   → Devuelve el lead + últimas 15 actividades.
 *
 * PATCH /api/bot/leads/[id]
 *   Body: { changes: { status?, notas?, monto?, presupuesto?, ... } }
 *   → Actualiza campos permitidos. Registra la actividad.
 *
 * Auth: header x-bot-secret
 */

// Campos que el bot puede actualizar. Cerramos el resto para evitar daño.
const ALLOWED_UPDATE_FIELDS = new Set([
  'status',
  'nombre',
  'empresa',
  'telefono',
  'email',
  'puesto',
  'canal_adquisicion',
  'presupuesto',
  'monto',
  'notas',
  'plan',
])

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  const supabase = createServiceClient()
  const { data: lead, error } = await supabase
    .from('leads').select('*').eq('id', params.id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!lead) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })

  const { data: acts } = await supabase
    .from('lead_actividad')
    .select('id,tipo,descripcion,created_at,metadata')
    .eq('lead_id', params.id)
    .order('created_at', { ascending: false })
    .limit(15)

  return NextResponse.json({ lead, activities: acts || [] })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  let body: { changes?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const changes = body.changes || {}
  const filtered: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(changes)) {
    if (ALLOWED_UPDATE_FIELDS.has(k)) filtered[k] = v
  }
  const rejected = Object.keys(changes).filter((k) => !ALLOWED_UPDATE_FIELDS.has(k))
  if (Object.keys(filtered).length === 0) {
    return NextResponse.json({
      error: 'ningún campo válido para actualizar',
      allowed_fields: Array.from(ALLOWED_UPDATE_FIELDS),
      rejected,
    }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Si cambia status, registrar status_changed_at
  const { data: current } = await supabase
    .from('leads').select('status').eq('id', params.id).maybeSingle()
  if (!current) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })

  if (filtered.status && filtered.status !== current.status) {
    filtered.status_changed_at = new Date().toISOString()
  }

  const { data: updated, error } = await supabase
    .from('leads').update(filtered).eq('id', params.id).select('*').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Log actividad
  await supabase.from('lead_actividad').insert({
    lead_id: params.id,
    tipo: 'bot_lead_updated',
    descripcion: `🤖 Asistente Fer actualizó: ${Object.keys(filtered).join(', ')}`,
    metadata: { source: 'asistente-fer-bot', changes: filtered, rejected },
  })

  return NextResponse.json({ ok: true, lead: updated, rejected_fields: rejected })
}
