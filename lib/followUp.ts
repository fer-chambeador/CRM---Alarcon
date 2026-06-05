import type { Lead } from './supabase'
import { createServiceClient } from './supabase'
import { createFollowUpReminder, deleteFollowUpReminder } from './googleCalendar'

type Supabase = ReturnType<typeof createServiceClient>

/**
 * Reacciona a cambios de status de un lead, creando o borrando el follow-up
 * de Google Calendar.
 *
 *   nuevo status === 'presentacion_enviada'  →  crear all-day event +3 días
 *   nuevo status === 'convertido'/'cliente_recurrente'/'descartado'  →  borrar follow-up si existe
 *   otros: no toca
 *
 * Best-effort: si falla la sync con GCal, NO bloquea el flujo principal.
 * Loguea el error a lead_actividad para que se vea en el feed.
 *
 * Devuelve el nuevo gcal_followup_event_id (si creó), o el viejo (si no cambió),
 * o null (si se borró).
 */
export async function handleStatusChangeForFollowUp(
  supabase: Supabase,
  leadId: string,
  fullLead: Lead,
  oldStatus: Lead['status'] | null,
  newStatus: Lead['status'],
  oldEventId: string | null,
): Promise<string | null> {
  const TRIGGER = 'presentacion_enviada'
  const CLOSE_STATUSES = new Set<Lead['status']>(['convertido', 'cliente_recurrente', 'descartado'])

  // Caso 1: transición HACIA presentacion_enviada → crear follow-up si NO existe ya.
  if (newStatus === TRIGGER && oldStatus !== TRIGGER && !oldEventId) {
    // FIX (7 jun 2026): además del evento en GCal, también INSERT en la tabla
    // follow_ups del CRM. Antes solo se creaba el evento en GCal y Fer tenía
    // que clickear "Importar de Calendar" para que aparecieran en /follow-ups.
    // Ahora aparecen automáticamente.
    const fechaFollowUp = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    fechaFollowUp.setUTCHours(15, 0, 0, 0)  // 09:00 a.m. hora MX (UTC-6)
    const titulo = `Follow Up presentación – ${fullLead.nombre || fullLead.email || fullLead.telefono || 'Lead'}`
    const notas = `Generado automáticamente tras enviar presentación a ${fullLead.empresa || fullLead.nombre || fullLead.telefono}. Confirmar si revisaron y avanzar a liga de pago o re-engage.`

    // Insert en follow_ups (no bloquea si falla — gcal sigue siendo source-of-truth)
    await supabase.from('follow_ups').insert({
      lead_id: leadId,
      titulo,
      notas,
      fecha: fechaFollowUp.toISOString(),
      tipo: 'presentacion',
      source: 'auto_presentacion',
    }).then(({ error }) => {
      if (error && !String(error.message).includes('duplicate')) {
        console.warn('[followUp] insert in follow_ups failed', error.message)
      }
    })

    try {
      const eventId = await createFollowUpReminder(supabase, fullLead, 3)
      if (eventId) {
        await supabase.from('leads')
          .update({ gcal_followup_event_id: eventId })
          .eq('id', leadId)
        // Backfill el gcal_event_id en el follow_up que acabamos de crear
        await supabase.from('follow_ups')
          .update({ gcal_event_id: eventId })
          .eq('lead_id', leadId)
          .eq('source', 'auto_presentacion')
          .is('gcal_event_id', null)
          .eq('completado', false)
        await supabase.from('lead_actividad').insert({
          lead_id: leadId,
          tipo: 'followup_created',
          descripcion: '📅 Follow-up agendado (CRM + Google Calendar +3 días)',
          metadata: { event_id: eventId, days_ahead: 3 },
        })
        return eventId
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await supabase.from('lead_actividad').insert({
        lead_id: leadId,
        tipo: 'followup_error',
        descripcion: `Falló creación de follow-up en GCal (pero CRM follow_up sí se creó): ${msg}`,
        metadata: { error: msg },
      })
      return oldEventId
    }
  }

  // Caso 2: transición HACIA un estado terminal (cerrado/descartado) → borrar
  // el follow-up si lo había, ya no aplica.
  if (CLOSE_STATUSES.has(newStatus) && oldEventId) {
    try {
      await deleteFollowUpReminder(supabase, oldEventId)
      await supabase.from('leads')
        .update({ gcal_followup_event_id: null })
        .eq('id', leadId)
      await supabase.from('lead_actividad').insert({
        lead_id: leadId,
        tipo: 'followup_deleted',
        descripcion: `📅 Follow-up borrado de GCal (lead pasó a ${newStatus})`,
        metadata: { event_id: oldEventId, reason: newStatus },
      })
      return null
    } catch (e) {
      // Best-effort: si ya estaba borrado en GCal (410) la función no tira,
      // pero por si tira otro error.
      const msg = e instanceof Error ? e.message : String(e)
      await supabase.from('lead_actividad').insert({
        lead_id: leadId,
        tipo: 'followup_error',
        descripcion: `Falló borrado de follow-up en GCal: ${msg}`,
        metadata: { error: msg, event_id: oldEventId },
      })
      return oldEventId
    }
  }

  return oldEventId
}
