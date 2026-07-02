import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { listEventsInRange, isConnected } from '@/lib/googleCalendar'
import { requireBotAuth } from '../_lib/auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * GET /api/bot/llamadas
 *
 * Source of truth: **Google Calendar** (source of truth para llamadas de Fer).
 * Lee los eventos upcoming de GCal, filtra a los relevantes (llamadas comerciales),
 * filtra por rango de fecha en hora MX, y trata de matchear cada uno a un lead
 * del CRM por teléfono/email (para dar contexto).
 *
 * Query params:
 *   range   — hoy | manana | semana (default: hoy)
 *   limit   — default 30, max 100
 *
 * Auth: header x-bot-secret
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g
const PHONE_RE = /(?:\+?52\s*)?(?:\d[\s-]?){10,15}\d/

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, '').replace(/^521/, '52').replace(/^1/, '')
}

/**
 * Extrae teléfono y email del evento (título + descripción). Basado en la lógica de
 * extractClientFromEvent en lib/googleCalendar.ts pero standalone.
 */
function extractContact(ev: {
  summary?: string
  description?: string
  attendees?: Array<{ email?: string; responseStatus?: string }>
  organizer?: { email?: string }
}): { telefono: string | null; email: string | null; nombreTitulo: string | null } {
  const title = ev.summary || ''
  const desc = ev.description || ''
  const ownerEmails = new Set(['fer@chambas.ai', 'max@chambas.ai'])
  if (ev.organizer?.email) ownerEmails.add(ev.organizer.email.toLowerCase())

  let telefono: string | null = null
  let email: string | null = null
  let nombreTitulo: string | null = null

  // Teléfono del título (formato Vambe)
  const phoneMatch = title.match(PHONE_RE) || desc.match(PHONE_RE)
  if (phoneMatch) telefono = phoneMatch[0]

  // Email — attendee no-owner primero, luego cualquier email en descripción
  for (const a of ev.attendees || []) {
    if (a.email && !ownerEmails.has(a.email.toLowerCase())) {
      email = a.email
      break
    }
  }
  if (!email) {
    const text = `${title}\n${desc}`
    const emails = text.match(EMAIL_RE) || []
    for (const m of emails) {
      if (!ownerEmails.has(m.toLowerCase())) { email = m; break }
    }
  }

  // Nombre del título
  const m1 = title.match(/\(([^)]+)\)\s*$/)              // "... (nombre)"
  const m2 = title.match(/^([^<>]+?)\s*<>/)              // "Nombre <> Llamada ..."
  const m3 = title.match(/Llamada\s*[-—]\s*([^\d+]+?)(?:\s+\+?\d|$)/i)  // "Llamada - nombre 5215..."
  nombreTitulo = (m1?.[1] || m2?.[1] || m3?.[1] || '').trim() || null

  return { telefono, email, nombreTitulo }
}

export async function GET(req: NextRequest) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  const url = new URL(req.url)
  const range = url.searchParams.get('range') || 'hoy'
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 100)

  const supabase = createServiceClient()

  // Chequear conexión GCal
  const conn = await isConnected(supabase)
  if (!conn.connected) {
    return NextResponse.json({
      error: 'Google Calendar no está conectado en el CRM',
      hint: 'Ve a /integrations en el CRM y conecta tu cuenta de Google.',
    }, { status: 503 })
  }

  // Rango en hora MX
  const now = new Date()
  const mxFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const todayMxStr = mxFmt.format(now)
  const startMx = new Date(`${todayMxStr}T00:00:00-06:00`)
  const endTodayMx = new Date(`${todayMxStr}T23:59:59.999-06:00`)
  const startTomorrowMx = new Date(startMx); startTomorrowMx.setUTCDate(startTomorrowMx.getUTCDate() + 1)
  const endTomorrowMx = new Date(endTodayMx); endTomorrowMx.setUTCDate(endTomorrowMx.getUTCDate() + 1)
  const endWeekMx = new Date(endTodayMx); endWeekMx.setUTCDate(endWeekMx.getUTCDate() + 7)

  let rangeStart = startMx
  let rangeEnd = endTodayMx
  if (range === 'manana') {
    rangeStart = startTomorrowMx
    rangeEnd = endTomorrowMx
  } else if (range === 'semana') {
    rangeStart = startMx
    rangeEnd = endWeekMx
  }

  // Traer eventos GCal EN el rango exacto (no desde `now` — necesitamos también los del mañana)
  let events
  try {
    events = await listEventsInRange(supabase, rangeStart.toISOString(), rangeEnd.toISOString(), 250)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `GCal error: ${msg}` }, { status: 502 })
  }

  // Filtrar por rango (todos los eventos con hora del día — no all-day).
  // Antes filtrábamos con isRelevantCalendarEvent pero era muy estricto (requería
  // "llamada"/"vendedor" en título). Ahora traemos todo y clasificamos con hint.
  const INTERNAL = ['sync', 'stand up', 'standup', '1:1', 'daily', 'weekly', 'chambeador', 'chambas team']
  const relevant = events
    .filter((ev) => ev.status !== 'cancelled')
    .filter((ev) => !!ev.start?.dateTime)  // skip all-day
    .filter((ev) => {
      const title = (ev.summary || '').toLowerCase()
      return !INTERNAL.some((k) => title.includes(k))
    })
    .filter((ev) => {
      const t = new Date(ev.start!.dateTime!).getTime()
      return t >= rangeStart.getTime() && t <= rangeEnd.getTime()
    })
    .slice(0, limit)

  // Match a leads del CRM
  const phones = Array.from(new Set(
    relevant.map((ev) => extractContact(ev).telefono).filter((x): x is string => !!x)
  ))
  const emails = Array.from(new Set(
    relevant.map((ev) => extractContact(ev).email).filter((x): x is string => !!x)
  ))

  type LeadInfo = {
    id: string
    nombre: string | null
    empresa: string | null
    telefono: string | null
    email: string | null
    canal_adquisicion: string | null
    presupuesto: string | null
    puesto: string | null
    status: string | null
    monto: number | null
    ultimo_contacto: string | null
    notas: string | null
  }
  const leadsByPhone = new Map<string, LeadInfo>()
  const leadsByEmail = new Map<string, LeadInfo>()

  if (phones.length > 0 || emails.length > 0) {
    // Buscar por teléfono normalizado (ilike de últimos 10 dígitos)
    const conditions: string[] = []
    for (const p of phones) {
      const norm = normalizePhone(p)
      if (norm.length >= 10) {
        const last10 = norm.slice(-10)
        conditions.push(`telefono.ilike.%${last10}%`)
      }
    }
    for (const e of emails) {
      conditions.push(`email.eq.${e}`)
    }

    if (conditions.length > 0) {
      const { data: leads } = await supabase
        .from('leads')
        .select('id,nombre,empresa,telefono,email,canal_adquisicion,presupuesto,puesto,status,monto,ultimo_contacto,notas')
        .or(conditions.join(','))
        .limit(200)

      for (const l of (leads || []) as LeadInfo[]) {
        if (l.telefono) {
          const norm = normalizePhone(l.telefono)
          if (norm.length >= 10) leadsByPhone.set(norm.slice(-10), l)
        }
        if (l.email) leadsByEmail.set(l.email.toLowerCase(), l)
      }
    }
  }

  // Construir respuesta
  const llamadas = relevant.map((ev) => {
    const contact = extractContact(ev)
    let lead: LeadInfo | null = null
    if (contact.telefono) {
      const norm = normalizePhone(contact.telefono)
      if (norm.length >= 10) lead = leadsByPhone.get(norm.slice(-10)) || null
    }
    if (!lead && contact.email) {
      lead = leadsByEmail.get(contact.email.toLowerCase()) || null
    }
    return {
      gcal_event_id: ev.id,
      titulo: ev.summary,
      fecha_utc: ev.start?.dateTime,
      fecha_cdmx: ev.start?.dateTime
        ? new Date(new Date(ev.start.dateTime as string).getTime() - 6 * 3600 * 1000).toISOString().replace('Z', '-06:00')
        : null,
      contacto_from_event: {
        nombre: contact.nombreTitulo,
        telefono: contact.telefono,
        email: contact.email,
      },
      lead: lead ? {
        id: lead.id,
        nombre: lead.nombre || lead.empresa,
        telefono: lead.telefono,
        canal: lead.canal_adquisicion,
        presupuesto: lead.presupuesto,
        puesto: lead.puesto,
        status: lead.status,
        monto: lead.monto,
        notas: lead.notas,
      } : null,
    }
  })

  return NextResponse.json({
    source: 'google_calendar',
    range,
    from: rangeStart.toISOString(),
    to: rangeEnd.toISOString(),
    connected_email: conn.google_email,
    debug: {
      events_from_gcal: events.length,
      events_after_filter: relevant.length,
    },
    count: llamadas.length,
    llamadas,
  })
}
