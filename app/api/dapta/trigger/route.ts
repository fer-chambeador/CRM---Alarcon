import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { triggerDaptaCall } from '@/lib/dapta'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/dapta/trigger
 *
 * Body: {
 *   lead_id: string
 *   trigger_reason?: string
 *   triggered_by?: string
 *   scheduled_at?: string   // ISO timestamp — si está en el futuro, NO llama ahora,
 *                           // solo crea la row queued y la dispara el cron
 * }
 *
 * Comportamiento:
 *  - scheduled_at futuro: crea fila status='queued' con scheduled_at; NO llama Dapta;
 *    NO mueve el lead a llamada_con_dapta (todavía no se llamó).
 *  - scheduled_at null o pasado: dispara la llamada YA + mueve lead a llamada_con_dapta.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    lead_id?: string
    trigger_reason?: string
    triggered_by?: string
    scheduled_at?: string | null
  } | null

  if (!body?.lead_id) {
    return NextResponse.json({ error: 'lead_id requerido' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', body.lead_id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!lead) return NextResponse.json({ error: 'lead no encontrado' }, { status: 404 })

  const l = lead as Lead
  if (!l.telefono) {
    return NextResponse.json({ error: 'el lead no tiene teléfono' }, { status: 400 })
  }

  // ── Normalizar el teléfono ANTES de cualquier operación ──
  // Si el teléfono está malformado (ej. formato MX viejo "+5201..." con
  // prefijo de larga distancia "01"), Dapta no puede marcar y la fila queda
  // stuck en 'dialing'. Bug visto con Yanelli + Petrus (2 jun 2026).
  //
  // Si normalizamos y el formato cambió, también ACTUALIZAMOS el lead en DB
  // para evitar volver a tener el mismo problema.
  const phoneNormalized = normalizeMexicanPhone(l.telefono)
  if (!phoneNormalized) {
    return NextResponse.json({
      error: 'el-telefono-no-es-valido',
      detail: `El teléfono '${l.telefono}' no se pudo normalizar a un formato MX válido. Edita el lead y corrige el número antes de llamar.`,
    }, { status: 400 })
  }
  if (phoneNormalized !== l.telefono) {
    // Actualizar el lead con el formato canónico para futuras operaciones.
    await supabase.from('leads').update({ telefono: phoneNormalized }).eq('id', l.id)
    await supabase.from('lead_actividad').insert({
      lead_id: l.id,
      tipo: 'field_change',
      descripcion: `Teléfono normalizado: ${l.telefono} → ${phoneNormalized}`,
      metadata: { field: 'telefono', before: l.telefono, after: phoneNormalized, source: 'dapta_trigger_auto_normalize' },
    })
    l.telefono = phoneNormalized
  }

  // ── REGLA DURA: 1 LLAMADA POR LEAD MÁXIMO ──
  // Nunca debemos volver a marcarle a un cliente al que ya intentamos contactar.
  // Si hay CUALQUIER llamada previa (queued, dialing, completed, failed, no_answer,
  // voicemail, canceled) — rechazamos. La única forma de "rebrincarse" esta regla
  // es marcando la llamada anterior como 'canceled' o pasándole ?force=1.
  //
  // Para casos legítimos donde quieras llamar de nuevo (ej. una semana después),
  // cancela la anterior primero y vuelve a disparar. Es deliberadamente fricción
  // para evitar bucles de cron y spam al cliente.
  const url = new URL(req.url)
  const force = url.searchParams.get('force') === '1'

  // Si el caller quiere forzar (re-llamar a un lead que ya tuvo llamada),
  // requerimos password. Esto previene loops accidentales y re-disparos
  // por mistap en la UI. El password está en env (DAPTA_FORCE_CALL_PASSWORD,
  // default '1234') — Fer lo conoce, no tiene que entrar a Railway para
  // hacer el re-disparo, pero un click accidental no lo va a disparar.
  if (force) {
    const passProvided = url.searchParams.get('password') || (body as { password?: string })?.password || req.headers.get('x-force-password')
    const passExpected = process.env.DAPTA_FORCE_CALL_PASSWORD || '1234'
    if (passProvided !== passExpected) {
      return NextResponse.json({
        error: 'force-password-required',
        detail: 'Para re-llamar a un lead con llamada previa necesitas pasar ?password=<password>. Pídeselo a Fer.',
      }, { status: 401 })
    }
  }

  if (!force) {
    const { data: prev } = await supabase
      .from('llamadas')
      .select('id, status, created_at')
      .eq('lead_id', l.id)
      .not('status', 'in', '(canceled)')
      .order('created_at', { ascending: false })
      .limit(1)
    if (prev && prev.length > 0) {
      const p = prev[0] as { id: string; status: string; created_at: string }
      return NextResponse.json({
        error: 'lead-already-called',
        detail: `Este lead ya tiene una llamada previa (status=${p.status}, creada ${p.created_at}). Para re-llamar, vuelve a intentar y captura el password cuando te lo pida la UI.`,
        previous_llamada_id: p.id,
        previous_status: p.status,
      }, { status: 409 })
    }
  }

  // Validar scheduled_at: si es string parseable a fecha futura, agendamos
  const scheduledMs = body.scheduled_at ? new Date(body.scheduled_at).getTime() : NaN
  const isScheduled = !isNaN(scheduledMs) && scheduledMs > Date.now() + 30_000 // > 30s en futuro

  // ── Caso scheduled (futuro) — solo crear la row ───────────────────────────
  if (isScheduled) {
    const { data: created, error: insErr } = await supabase
      .from('llamadas')
      .insert({
        lead_id: l.id,
        to_number: l.telefono,
        from_number: process.env.DAPTA_FROM_NUMBER || null,
        agent_name: process.env.DAPTA_AGENT_NAME_DEFAULT || 'Daniela',
        status: 'queued',
        scheduled_at: new Date(scheduledMs).toISOString(),
        triggered_by: body.triggered_by || null,
        trigger_reason: body.trigger_reason || 'scheduled',
      })
      .select('id')
      .maybeSingle()
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    const llamadaId = (created as { id?: string } | null)?.id

    if (llamadaId) {
      await supabase.from('lead_actividad').insert({
        lead_id: l.id,
        tipo: 'dapta_call_scheduled',
        descripcion: `📅 Llamada Dapta agendada para ${new Date(scheduledMs).toLocaleString('es-MX')}`,
        metadata: { source: 'dapta', llamada_id: llamadaId, scheduled_at: new Date(scheduledMs).toISOString() },
      })
    }
    return NextResponse.json({ ok: true, scheduled: true, llamada_id: llamadaId, scheduled_at: new Date(scheduledMs).toISOString() })
  }

  // ── Caso inmediato — disparar ahora ───────────────────────────────────────
  const triggerResult = await triggerDaptaCall({
    lead_id: l.id,
    to_number: l.telefono,
    nombre: l.nombre,
    empresa: l.empresa,
    vacante: l.vacante,
    presupuesto: l.presupuesto,
    puesto: l.puesto,
    notas: l.notas,
  })

  const insert: Record<string, unknown> = {
    lead_id: l.id,
    to_number: l.telefono,
    from_number: process.env.DAPTA_FROM_NUMBER || null,
    agent_name: process.env.DAPTA_AGENT_NAME_DEFAULT || 'Daniela',
    // 'dialing' = se mandó el trigger a Dapta, esperamos el post-call que la mueva a completed/failed.
    // 'queued' se reserva para llamadas agendadas que aún no se disparan.
    status: triggerResult.ok ? 'dialing' : 'failed',
    triggered_by: body.triggered_by || null,
    trigger_reason: body.trigger_reason || 'manual',
    error_message: triggerResult.ok ? null : (triggerResult.error || 'unknown'),
  }

  const { data: created, error: insErr } = await supabase
    .from('llamadas')
    .insert(insert)
    .select('id')
    .maybeSingle()

  if (insErr) {
    console.error('Error creando llamada:', insErr)
    return NextResponse.json({
      ok: triggerResult.ok,
      dapta: triggerResult,
      db_error: insErr.message,
    }, { status: 500 })
  }

  const llamadaId = (created as { id?: string } | null)?.id

  // ── Mover el lead al bucket "llamada_con_dapta" ──
  // Solo si la llamada se disparó OK Y el lead no está ya en una etapa más avanzada.
  if (triggerResult.ok) {
    const ADVANCED_STATUSES = new Set(['llamada_agendada', 'no_show_llamada', 'presentacion_enviada', 'espera_aprobacion', 'convertido', 'cliente_recurrente'])
    if (!ADVANCED_STATUSES.has(l.status)) {
      await supabase
        .from('leads')
        .update({ status: 'llamada_con_dapta', status_changed_at: new Date().toISOString() })
        .eq('id', l.id)
    }
  }

  if (llamadaId) {
    await supabase.from('lead_actividad').insert({
      lead_id: l.id,
      tipo: 'dapta_call_triggered',
      descripcion: triggerResult.ok
        ? `📞 Llamada Dapta disparada a ${l.telefono}`
        : `❌ Falló disparo de llamada Dapta: ${triggerResult.error}`,
      metadata: { source: 'dapta', llamada_id: llamadaId, trigger_reason: body.trigger_reason, ok: triggerResult.ok },
    })
  }

  return NextResponse.json({
    ok: triggerResult.ok,
    llamada_id: llamadaId,
    dapta: triggerResult.ok ? { status: triggerResult.status } : triggerResult,
  }, { status: triggerResult.ok ? 200 : 502 })
}
