import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { getMessages } from '@/lib/vambe'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/vambe/sync-call-dates?dry=true|false&secret=...
 *
 * Para cada lead en status=llamada_agendada que NO tenga llamada_at, busca
 * en los mensajes de Vambe una mención de fecha/hora y la guarda.
 *
 * Ejemplo de mensaje detectado:
 *   "¡Perfecto, Liz! A las 11:30 am está excelente."
 *   → llamada_at = today 11:30 (o mañana si ya pasó hoy)
 *
 * Idempotente — si ya tiene llamada_at, no hace nada.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!process.env.VAMBE_WEBHOOK_SECRET || secret !== process.env.VAMBE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const dry = url.searchParams.get('dry') !== 'false'

  const supabase = createServiceClient()

  // Leads en llamada_agendada SIN fecha y con vambe_contact_id (para poder fetchear)
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, nombre, email, telefono, vambe_contact_id, llamada_at, status')
    .eq('status', 'llamada_agendada')
    .is('llamada_at', null)
    .not('vambe_contact_id', 'is', null)
    .order('status_changed_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (leads || []) as Pick<Lead, 'id' | 'nombre' | 'email' | 'telefono' | 'vambe_contact_id' | 'llamada_at' | 'status'>[]
  const stats = {
    dry,
    total: rows.length,
    found_date: 0,
    no_date_in_messages: 0,
    write_errors: [] as Array<{ id: string; error: string }>,
    updates: [] as Array<{ id: string; nombre: string | null; email: string | null; llamada_at: string }>,
  }

  for (const lead of rows) {
    if (!lead.vambe_contact_id) continue

    try {
      const messages = await getMessages(lead.vambe_contact_id, 30)
      const llamadaAt = extractDateFromMessages(messages.map(m => ({
        message: m.message || '',
        created_at: m.created_at,
      })))

      if (!llamadaAt) {
        stats.no_date_in_messages++
        continue
      }

      stats.found_date++
      stats.updates.push({
        id: lead.id,
        nombre: lead.nombre,
        email: lead.email,
        llamada_at: llamadaAt,
      })

      if (!dry) {
        const { error: upErr } = await supabase
          .from('leads')
          .update({ llamada_at: llamadaAt })
          .eq('id', lead.id)
        if (upErr) {
          stats.write_errors.push({ id: lead.id, error: upErr.message })
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      stats.write_errors.push({ id: lead.id, error: msg })
    }
  }

  return NextResponse.json(stats)
}

/**
 * Parser de fechas en texto plano (copiado del webhook para no acoplar).
 * Detecta patrones tipo "agendamos para mañana 11:30 am" o "lunes 10:00".
 */
function extractDateFromMessages(messages: Array<{ message: string; created_at: string }>): string | null {
  const recent = messages.slice(0, 10)
  for (const msg of recent) {
    const text = msg.message || ''
    if (!text) continue

    const isAgendaMsg = /(agendad[ao]|confirmad[ao]|cita|llamada|reunion|reunion[ée]|reservad[ao]|booking).{0,40}(am|pm|hora|hrs|hr|:|\d)/i.test(text)
    if (!isAgendaMsg) continue

    const hm = text.match(/(\b\d{1,2}):(\d{2})\s*(am|pm|hrs?)?\b/i)
    if (!hm) continue
    let hour = parseInt(hm[1], 10)
    const minute = parseInt(hm[2], 10)
    const ampm = (hm[3] || '').toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0

    const baseDate = new Date(msg.created_at)
    const targetDate = new Date(baseDate)

    if (/\bma[nñ]ana\b/i.test(text)) {
      targetDate.setDate(targetDate.getDate() + 1)
    } else if (/\bhoy\b/i.test(text)) {
      // mismo día
    } else {
      const dayNames: Record<string, number> = {
        domingo: 0, lunes: 1, martes: 2, mi: 3, miercoles: 3, miércoles: 3,
        jueves: 4, viernes: 5, sabado: 6, sábado: 6, sab: 6,
      }
      for (const [name, dow] of Object.entries(dayNames)) {
        if (new RegExp(`\\b${name}\\w*\\b`, 'i').test(text)) {
          const currentDow = targetDate.getDay()
          const diff = (dow - currentDow + 7) % 7 || 7
          targetDate.setDate(targetDate.getDate() + diff)
          break
        }
      }
    }

    targetDate.setHours(hour, minute, 0, 0)
    if (!isNaN(targetDate.getTime())) {
      return targetDate.toISOString()
    }
  }
  return null
}
