import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { normalizeCanal } from '@/lib/canales'
import { syncLeadToCalendar } from '@/lib/googleCalendar'
import { handleStatusChangeForFollowUp } from '@/lib/followUp'
import type { Lead } from '@/lib/supabase'

const ALLOWED = ['nombre','empresa','telefono','puesto','canal_adquisicion','status','notas','plan','veces_contactado','monto','estado','presupuesto','vacante','llamada_at','tipo_llamada','created_at'] as const

/** Labels human-readable para los registros de actividad. */
const FIELD_LABELS: Record<string, string> = {
  nombre: 'Nombre',
  empresa: 'Empresa',
  telefono: 'Teléfono',
  puesto: 'Puesto',
  canal_adquisicion: 'Canal',
  status: 'Status',
  notas: 'Notas',
  plan: 'Plan',
  veces_contactado: 'Intentos de contacto',
  monto: 'Monto',
  estado: 'Ubicación',
  presupuesto: 'Presupuesto',
  vacante: 'Vacante',
  llamada_at: 'Llamada agendada',
  tipo_llamada: 'Tipo de llamada',
  ultimo_contacto: 'Último contacto',
}

/** Formatea un valor para mostrarlo en el log. */
function fmtVal(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '(vacío)'
  if (field === 'monto') return `$${Number(v).toLocaleString('es-MX')}`
  if (field === 'llamada_at' || field === 'ultimo_contacto') {
    try { return new Date(v as string).toLocaleString('es-MX') } catch { return String(v) }
  }
  const s = String(v)
  return s.length > 80 ? s.slice(0, 77) + '…' : s
}

/** Descripción human-readable para un cambio. */
function describeChange(field: string, before: unknown, after: unknown): string {
  const label = FIELD_LABELS[field] || field
  if (field === 'status') return `Status cambiado a: ${after}`
  if (field === 'notas') {
    if (!before && after) return 'Nota agregada'
    if (before && !after) return 'Nota eliminada'
    return 'Nota actualizada'
  }
  if (field === 'veces_contactado') {
    return `Intentos de contacto: ${before ?? 0} → ${after ?? 0}`
  }
  return `${label}: ${fmtVal(field, before)} → ${fmtVal(field, after)}`
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })
  return NextResponse.json(data)
}

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

  // SET directo de veces_contactado (desde el ContactoSelector). CUALQUIER
  // cambio (sube o baja) resetea el aging "días sin contactar" — el user
  // explicitó que cada vez que se ajusta el nivel de contacto debe
  // contarse como una interacción nueva.
  if (sentVeces && !body.incrementar_contacto) {
    const { data: lead } = await supabase.from('leads').select('veces_contactado').eq('id', id).single()
    const prev = (lead?.veces_contactado as number) || 0
    updates.veces_contactado = body.veces_contactado
    if (body.veces_contactado !== prev) {
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

  // Leer el lead ANTES del update para poder comparar y registrar
  // qué cambió campo por campo.
  const { data: leadBefore } = await supabase.from('leads').select('*').eq('id', id).single()

  const { data, error } = await supabase.from('leads').update(updates).eq('id', id).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Registrar UN evento por cada campo que realmente cambió.
  if (leadBefore) {
    const before = leadBefore as Record<string, unknown>
    const actividades: Array<{ lead_id: string; tipo: string; descripcion: string; metadata: Record<string, unknown> }> = []
    for (const [field, after] of Object.entries(updates)) {
      const prev = before[field]
      // Skip si no cambió (loose compare para null vs undefined)
      if ((prev ?? null) === (after ?? null)) continue
      const tipo = field === 'status' ? 'status_change'
        : field === 'monto' ? 'monto_update'
        : 'field_change'
      actividades.push({
        lead_id: id,
        tipo,
        descripcion: describeChange(field, prev, after),
        metadata: { field, before: prev, after },
      })
    }
    if (actividades.length > 0) {
      await supabase.from('lead_actividad').insert(actividades)
    }
  }

  // Auto-create follow-up en GCal cuando status cambia a 'presentacion_enviada'
  // (y borrarlo si pasa a un estado terminal). Best-effort, no bloquea la
  // respuesta si falla. Ver lib/followUp.ts para la lógica completa.
  if (leadBefore && 'status' in updates) {
    const before = leadBefore as Record<string, unknown>
    const oldStatus = (before.status as Lead['status']) ?? null
    const newStatus = updates.status as Lead['status']
    const oldFollowUpId = (before.gcal_followup_event_id as string | null) ?? null
    if (oldStatus !== newStatus) {
      await handleStatusChangeForFollowUp(
        supabase,
        id,
        data as Lead,
        oldStatus,
        newStatus,
        oldFollowUpId,
      )
    }
  }

  // Sync con Google Calendar si llamada_at cambió. Best-effort, no
  // bloquea la respuesta si falla.
  if (leadBefore && 'llamada_at' in updates) {
    const before = leadBefore as Record<string, unknown>
    const oldLlamada = (before.llamada_at as string | null) ?? null
    const newLlamada = (updates.llamada_at as string | null) ?? null
    const oldEventId = (before.google_calendar_event_id as string | null) ?? null
    if (oldLlamada !== newLlamada) {
      const sync = await syncLeadToCalendar(supabase, data, newLlamada, oldEventId)
      if (sync.ok && sync.event_id !== oldEventId) {
        await supabase.from('leads')
          .update({ google_calendar_event_id: sync.event_id })
          .eq('id', id)
      }
      if (!sync.ok) {
        await supabase.from('lead_actividad').insert({
          lead_id: id,
          tipo: 'calendar_sync_error',
          descripcion: `Falló sync con Google Calendar: ${sync.error}`,
          metadata: { error: sync.error },
        })
      }
    }
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
