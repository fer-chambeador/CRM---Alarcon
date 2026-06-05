import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { listUpcomingEvents, deleteFollowUpReminder } from '@/lib/googleCalendar'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * POST /api/follow-ups/import-from-gcal?delete=1
 *
 * Lista todos los eventos próximos del Google Calendar de Fer cuyo título empieza
 * con "Follow Up - " (o "Follow up - "), crea filas en follow_ups con esos datos,
 * y si delete=1 los borra del calendar.
 *
 * Body opcional: { days_ahead?: number = 90 }
 * Retorna: { imported, deleted, skipped, errors }
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  const shouldDelete = url.searchParams.get('delete') === '1'
  const body = await req.json().catch(() => ({}))
  const daysAhead = Number.isFinite(body?.days_ahead) ? Math.min(Math.max(body.days_ahead, 1), 365) : 90

  const supabase = createServiceClient()
  let events
  try {
    events = await listUpcomingEvents(supabase, daysAhead)
  } catch (e) {
    return NextResponse.json({ error: `Falló listar eventos: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 })
  }

  const followUpEvents = events.filter(ev => {
    const s = (ev.summary || '').toLowerCase()
    return s.startsWith('follow up') || s.startsWith('follow-up') || s.startsWith('followup')
  })

  let imported = 0
  let deleted = 0
  let skipped = 0
  const errors: Array<{ event_id: string; error: string }> = []

  for (const ev of followUpEvents) {
    try {
      // Skip si ya está importado
      const { data: existing } = await supabase
        .from('follow_ups').select('id').eq('gcal_event_id', ev.id).maybeSingle()
      if (existing) {
        // ya importado — pero igual borramos del calendar si se pidió
        if (shouldDelete) {
          try { await deleteFollowUpReminder(supabase, ev.id); deleted++ }
          catch (e) { errors.push({ event_id: ev.id, error: `delete: ${e instanceof Error ? e.message : String(e)}` }) }
        }
        skipped++
        continue
      }

      // Match lead por teléfono en el título "Follow Up - Nombre - +52123..."
      const summary = ev.summary || 'Follow Up'
      const phoneMatch = summary.match(/(\+?52\d{10,12}|\d{10,12})/)
      let leadId: string | null = null
      if (phoneMatch) {
        const phone = phoneMatch[0].replace(/^\+?52/, '')
        const { data: lead } = await supabase
          .from('leads')
          .select('id')
          .ilike('telefono', `%${phone}%`)
          .limit(1)
          .maybeSingle()
        if (lead) leadId = lead.id
      }

      // Si no hay match por teléfono, intentar por email
      if (!leadId && ev.description) {
        const emailMatch = ev.description.match(/[\w.+-]+@[\w-]+\.[\w.]+/)
        if (emailMatch) {
          const { data: lead } = await supabase
            .from('leads').select('id').eq('email', emailMatch[0]).maybeSingle()
          if (lead) leadId = lead.id
        }
      }

      // Fecha del evento (all-day → 9am MX por convención)
      let fecha: string
      if (ev.start?.dateTime) {
        fecha = ev.start.dateTime
      } else if (ev.start?.date) {
        // all-day → fijar a 9am hora MX
        fecha = new Date(`${ev.start.date}T09:00:00-06:00`).toISOString()
      } else {
        skipped++
        continue
      }

      const { error: insertErr } = await supabase.from('follow_ups').insert({
        lead_id: leadId,
        titulo: summary,
        notas: ev.description || null,
        fecha,
        tipo: summary.toLowerCase().includes('llamada') ? 'llamada'
          : summary.toLowerCase().includes('pago') ? 'pago'
          : summary.toLowerCase().includes('present') ? 'presentacion'
          : 'general',
        source: 'gcal_import',
        gcal_event_id: ev.id,
      })

      if (insertErr) {
        // Race-condition guard: si otro worker ya insertó el mismo
        // gcal_event_id entre nuestro check `existing` y este INSERT,
        // el UNIQUE constraint (uq_follow_ups_gcal) devuelve 23505.
        // En ese caso tratamos como skipped, no error.
        if (insertErr.code === '23505' || /duplicate|unique/i.test(insertErr.message)) {
          skipped++
          continue
        }
        errors.push({ event_id: ev.id, error: `insert: ${insertErr.message}` })
        continue
      }
      imported++

      if (shouldDelete) {
        try {
          await deleteFollowUpReminder(supabase, ev.id)
          deleted++
        } catch (e) {
          errors.push({ event_id: ev.id, error: `delete: ${e instanceof Error ? e.message : String(e)}` })
        }
      }
    } catch (e) {
      errors.push({ event_id: ev.id, error: `unexpected: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return NextResponse.json({
    found: followUpEvents.length,
    imported,
    deleted,
    skipped,
    errors: errors.slice(0, 20),
    errors_count: errors.length,
  })
}
