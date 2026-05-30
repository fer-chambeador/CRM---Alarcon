import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { getMessages } from '@/lib/vambe'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/admin/sync-call-dates?dry=true|false
 *
 * Mirror of /api/vambe/sync-call-dates pero sin secret — endpoint efímero.
 * Para cada lead en llamada_agendada sin llamada_at, busca fecha en mensajes Vambe.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const dry = url.searchParams.get('dry') !== 'false'

  const supabase = createServiceClient()
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
      if (!llamadaAt) { stats.no_date_in_messages++; continue }
      stats.found_date++
      stats.updates.push({ id: lead.id, nombre: lead.nombre, email: lead.email, llamada_at: llamadaAt })
      if (!dry) {
        const { error: upErr } = await supabase.from('leads').update({ llamada_at: llamadaAt }).eq('id', lead.id)
        if (upErr) stats.write_errors.push({ id: lead.id, error: upErr.message })
      }
    } catch (e) {
      stats.write_errors.push({ id: lead.id, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return NextResponse.json(stats, { headers: { 'Cache-Control': 'no-store' } })
}

function extractDateFromMessages(messages: Array<{ message: string; created_at: string }>): string | null {
  const recent = messages.slice(0, 15)
  for (const msg of recent) {
    const text = msg.message || ''
    if (!text) continue
    const isAgendaMsg = /(agendad[ao]|confirmad[ao]|cita|llamada|reunion|reunion[ée])\b/i.test(text)
      || /\b(perfecto|excelente|listo)\b.*\b(am|pm)\b/i.test(text)
    if (!isAgendaMsg) continue

    const hm = text.match(/(\b\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    if (!hm) continue
    let hour = parseInt(hm[1], 10)
    const minute = parseInt(hm[2] || '0', 10)
    const ampm = (hm[3] || '').toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0

    const baseDate = new Date(msg.created_at)
    const targetDate = new Date(baseDate)
    if (/\bma[nñ]ana\b/i.test(text)) {
      targetDate.setDate(targetDate.getDate() + 1)
    } else if (/\bhoy\b/i.test(text)) {
      // same day
    } else {
      const dayNames: Record<string, number> = {
        domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6,
      }
      let matched = false
      for (const [name, dow] of Object.entries(dayNames)) {
        if (new RegExp(`\\b${name}\\b`, 'i').test(text)) {
          const currentDow = targetDate.getDay()
          const diff = (dow - currentDow + 7) % 7 || 7
          targetDate.setDate(targetDate.getDate() + diff)
          matched = true
          break
        }
      }
      if (!matched) {
        const monthNames: Record<string, number> = {
          enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
        }
        const dm = text.match(/(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i)
        if (dm) {
          const day = parseInt(dm[1], 10)
          const month = monthNames[dm[2].toLowerCase()]
          if (!isNaN(day) && month !== undefined) targetDate.setMonth(month, day)
        }
      }
    }
    targetDate.setHours(hour, minute, 0, 0)
    if (!isNaN(targetDate.getTime())) return targetDate.toISOString()
  }
  return null
}
