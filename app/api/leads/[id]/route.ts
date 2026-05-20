import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { normalizeCanal } from '@/lib/canales'

const ALLOWED = ['nombre','empresa','telefono','puesto','canal_adquisicion','status','notas','plan','veces_contactado','monto','estado','presupuesto','vacante','llamada_at'] as const

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const body = await req.json()
  const { id } = params

  const updates: Record<string, unknown> = {}
  for (const key of ALLOWED) {
    if (key in body) updates[key] = body[key]
  }
  if ('canal_adquisicion' in updates) {
    updates.canal_adquisicion = normalizeCanal(updates.canal_adquisicion as string | null | undefined)
  }
  if ('monto' in updates) {
    const n = Number(updates.monto)
    updates.monto = Number.isFinite(n) && n >= 0 ? n : 1160
  }

  const sentVeces = typeof body.veces_contactado === 'number'

  // SET directo de veces_contactado (desde el ContactoSelector). Sube o baja.
  // Si SUBE → registra ultimo_contacto = now (cuenta como un nuevo intento, resetea aging).
  // Si BAJA → corrección, no toca ultimo_contacto.
  if (sentVeces && !body.incrementar_contacto) {
    const { data: lead } = await supabase.from('leads').select('veces_contactado').eq('id', id).single()
    const prev = (lead?.veces_contactado as number) || 0
    updates.veces_contactado = body.veces_contactado
    if (body.veces_contactado > prev) {
      updates.ultimo_contacto = new Date().toISOString()
    }
  }

  // Auto-bump SOLO si el cliente NO mandó veces_contactado explícito.
  // Si lo mandó, respetamos su valor (no le sumamos +1 por encima).
  if (!sentVeces && (body.status === 'contactado' || body.incrementar_contacto)) {
    const { data: lead } = await supabase.from('leads').select('veces_contactado, status').eq('id', id).single()
    if (lead) {
      // Si es bump explícito O si el lead recién entra a 'contactado' (transición).
      const isTransition = body.status === 'contactado' && lead.status !== 'contactado'
      if (body.incrementar_contacto || isTransition) {
        updates.veces_contactado = (lead.veces_contactado || 0) + 1
        updates.ultimo_contacto = new Date().toISOString()
      }
    }
  }

  const { data, error } = await supabase.from('leads').update(updates).eq('id', id).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (body.status) {
    await supabase.from('lead_actividad').insert({
      lead_id: id,
      tipo: 'status_change',
      descripcion: `Status cambiado a: ${body.status}`,
      metadata: updates,
    })
  }
  if ('monto' in body && typeof body.monto === 'number') {
    await supabase.from('lead_actividad').insert({
      lead_id: id,
      tipo: 'monto_update',
      descripcion: `Monto actualizado a $${body.monto.toLocaleString('es-MX')} MXN`,
      metadata: { monto: body.monto },
    })
  }

  return NextResponse.json(data)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const { id } = params
  await supabase.from('lead_actividad').delete().eq('lead_id', id)
  const { error } = await supabase.from('leads').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
