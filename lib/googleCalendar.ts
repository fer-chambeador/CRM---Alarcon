import { createServiceClient } from './supabase'
import type { Lead } from './supabase'

/**
 * Google Calendar integration — OAuth 2.0 + Calendar API helpers.
 *
 * Env vars necesarias (Railway):
 *  - GOOGLE_OAUTH_CLIENT_ID
 *  - GOOGLE_OAUTH_CLIENT_SECRET
 *  - GOOGLE_OAUTH_REDIRECT_URI  (ej. https://crm-alarcon-production.up.railway.app/api/integrations/google/callback)
 *
 * Setup en Google Cloud Console:
 *   1. APIs & Services → Enable "Google Calendar API"
 *   2. APIs & Services → OAuth consent screen (External, agregar tu email como test user)
 *   3. APIs & Services → Credentials → Create OAuth client ID (Web app)
 *      - Authorized redirect URI: el GOOGLE_OAUTH_REDIRECT_URI de arriba
 *   4. Copiar Client ID + Client Secret a Railway env vars
 */

const SCOPES = ['https://www.googleapis.com/auth/calendar.events']
const USER_ID = 'fer'  // single-user for now

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

type Supabase = ReturnType<typeof createServiceClient>

type StoredToken = {
  id: string
  user_id: string
  access_token: string
  refresh_token: string
  token_expires_at: string
  calendar_id: string | null
  google_email: string | null
}

// ─── OAuth ──────────────────────────────────────────────────────────────
export function getAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI || '',
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',   // necesario para obtener refresh_token
    prompt: 'consent',         // fuerza el refresh_token aunque ya haya conectado antes
    include_granted_scopes: 'true',
  })
  return `${AUTH_URL}?${params}`
}

export async function exchangeCode(code: string): Promise<{
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  id_token?: string
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI || '',
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`Google token exchange falló: ${res.status} ${await res.text()}`)
  return res.json()
}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Refresh token falló: ${res.status} ${await res.text()}`)
  return res.json()
}

/** Decodifica el id_token de Google (solo el payload, sin verificar firma). */
function decodeIdToken(idToken: string): { email?: string } | null {
  try {
    const [, payload] = idToken.split('.')
    return JSON.parse(Buffer.from(payload, 'base64').toString())
  } catch { return null }
}

export async function saveTokens(supabase: Supabase, tokens: Awaited<ReturnType<typeof exchangeCode>>) {
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString()
  const email = tokens.id_token ? decodeIdToken(tokens.id_token)?.email ?? null : null
  await supabase.from('google_calendar_tokens').upsert({
    user_id: USER_ID,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt,
    scope: tokens.scope,
    google_email: email,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })
}

/** Devuelve un access_token válido, refrescando si está por expirar. */
export async function getValidAccessToken(supabase: Supabase): Promise<{ accessToken: string; calendarId: string; googleEmail: string | null } | null> {
  const { data } = await supabase
    .from('google_calendar_tokens')
    .select('*')
    .eq('user_id', USER_ID)
    .single()
  if (!data) return null
  const stored = data as StoredToken

  const expiresAt = new Date(stored.token_expires_at).getTime()
  if (Date.now() < expiresAt) {
    return {
      accessToken: stored.access_token,
      calendarId: stored.calendar_id || 'primary',
      googleEmail: stored.google_email,
    }
  }

  // Refresh
  const refreshed = await refreshAccessToken(stored.refresh_token)
  const newExpires = new Date(Date.now() + (refreshed.expires_in - 60) * 1000).toISOString()
  await supabase.from('google_calendar_tokens')
    .update({
      access_token: refreshed.access_token,
      token_expires_at: newExpires,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', USER_ID)
  return {
    accessToken: refreshed.access_token,
    calendarId: stored.calendar_id || 'primary',
    googleEmail: stored.google_email,
  }
}

export async function disconnect(supabase: Supabase) {
  await supabase.from('google_calendar_tokens').delete().eq('user_id', USER_ID)
  await supabase.from('leads').update({ google_calendar_event_id: null }).not('google_calendar_event_id', 'is', null)
}

// ─── Calendar API ───────────────────────────────────────────────────────
type CalendarEvent = {
  summary: string
  description: string
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
}

function buildEvent(lead: Pick<Lead, 'nombre' | 'empresa' | 'email' | 'telefono' | 'vacante' | 'notas'>, llamadaAt: string): CalendarEvent {
  const start = new Date(llamadaAt)
  const end = new Date(start.getTime() + 30 * 60_000)  // 30 min default
  const title = `📞 ${lead.nombre || lead.empresa || lead.email}`
  const descParts: string[] = []
  if (lead.empresa) descParts.push(`Empresa: ${lead.empresa}`)
  if (lead.email)   descParts.push(`Email: ${lead.email}`)
  if (lead.telefono) descParts.push(`Teléfono: ${lead.telefono}`)
  if (lead.vacante) descParts.push(`Vacante: ${lead.vacante}`)
  if (lead.notas)   descParts.push('\nNotas:\n' + lead.notas)
  descParts.push('\n— Sincronizado desde Chambas CRM')
  return {
    summary: title,
    description: descParts.join('\n'),
    start: { dateTime: start.toISOString(), timeZone: 'America/Mexico_City' },
    end:   { dateTime: end.toISOString(),   timeZone: 'America/Mexico_City' },
  }
}

async function calendarFetch(supabase: Supabase, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  const auth = await getValidAccessToken(supabase)
  if (!auth) throw new Error('Google Calendar no está conectado')
  const url = `${CALENDAR_API}${path.replace('{calendarId}', encodeURIComponent(auth.calendarId))}`
  const res = await fetch(url, {
    method,
    headers: {
      'authorization': `Bearer ${auth.accessToken}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok && res.status !== 410) {  // 410 = ya borrado
    const text = await res.text()
    throw new Error(`Calendar API ${res.status}: ${text.slice(0, 300)}`)
  }
  if (method === 'DELETE') return null
  return res.json()
}

export async function createCalendarEvent(
  supabase: Supabase,
  lead: Pick<Lead, 'nombre' | 'empresa' | 'email' | 'telefono' | 'vacante' | 'notas'>,
  llamadaAt: string,
): Promise<string> {
  const event = buildEvent(lead, llamadaAt)
  const result = await calendarFetch(supabase, 'POST', '/calendars/{calendarId}/events', event)
  return result?.id || ''
}

export async function updateCalendarEvent(
  supabase: Supabase,
  eventId: string,
  lead: Pick<Lead, 'nombre' | 'empresa' | 'email' | 'telefono' | 'vacante' | 'notas'>,
  llamadaAt: string,
): Promise<void> {
  const event = buildEvent(lead, llamadaAt)
  await calendarFetch(supabase, 'PATCH', `/calendars/{calendarId}/events/${encodeURIComponent(eventId)}`, event)
}

export async function deleteCalendarEvent(supabase: Supabase, eventId: string): Promise<void> {
  await calendarFetch(supabase, 'DELETE', `/calendars/{calendarId}/events/${encodeURIComponent(eventId)}`)
}

/**
 * Sincroniza el lead con Calendar según el estado de su llamada_at.
 *  - llamada_at == null → si tiene event_id, BORRAR evento + limpiar event_id
 *  - llamada_at set + no event_id → CREAR evento
 *  - llamada_at set + event_id → ACTUALIZAR evento
 *
 * NO lanza errores hacia arriba — si falla la sync, lo loguea pero el update del lead no se rompe.
 * Devuelve el nuevo event_id (o null si se borró).
 */
export async function syncLeadToCalendar(
  supabase: Supabase,
  lead: Lead,
  newLlamadaAt: string | null,
  oldEventId: string | null,
): Promise<{ ok: boolean; event_id: string | null; error?: string }> {
  try {
    if (!newLlamadaAt) {
      if (oldEventId) {
        await deleteCalendarEvent(supabase, oldEventId)
      }
      return { ok: true, event_id: null }
    }
    if (oldEventId) {
      await updateCalendarEvent(supabase, oldEventId, lead, newLlamadaAt)
      return { ok: true, event_id: oldEventId }
    }
    const id = await createCalendarEvent(supabase, lead, newLlamadaAt)
    return { ok: true, event_id: id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, event_id: oldEventId, error: msg }
  }
}

// ─── Follow-up reminder (all-day event +3 días) ─────────────────────────
//
// Cuando un lead pasa a status='presentacion_enviada' creamos un all-day
// event en GCal 3 días después con título "Follow Up - {nombre} - {telefono}".
// All-day events aparecen como una barra arriba del día — visualmente
// equivalente a un recordatorio sin requerir el scope de Tasks API.

type FollowUpLead = Pick<Lead, 'nombre' | 'empresa' | 'email' | 'telefono' | 'vacante' | 'notas' | 'monto'>

function ymd(d: Date): string {
  // YYYY-MM-DD en zona horaria CDMX (sin shift por UTC).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(d) // 'YYYY-MM-DD'
}

/** Construye el title canónico del follow-up: "Follow Up - {nombre} - {telefono}". */
export function followUpTitle(lead: Pick<Lead, 'nombre' | 'empresa' | 'email' | 'telefono'>): string {
  const who = lead.nombre || lead.empresa || lead.email || 'Lead'
  const tel = lead.telefono || 's/teléfono'
  return `Follow Up - ${who} - ${tel}`
}

/** Crea all-day event con default duedate = hoy+3días (CDMX). */
export async function createFollowUpReminder(
  supabase: Supabase,
  lead: FollowUpLead & { email: string },
  daysAhead = 3,
): Promise<string> {
  const due = new Date(Date.now() + daysAhead * 86400_000)
  const startDate = ymd(due)
  // GCal all-day: end.date debe ser DÍA SIGUIENTE (exclusivo) para que ocupe
  // solo el día de start.
  const endDt = new Date(due.getTime() + 86400_000)
  const endDate = ymd(endDt)

  const descLines: string[] = []
  descLines.push(`Lead: ${lead.nombre || lead.empresa || lead.email}`)
  if (lead.empresa) descLines.push(`Empresa: ${lead.empresa}`)
  if (lead.telefono) descLines.push(`Teléfono: ${lead.telefono}`)
  if (lead.email) descLines.push(`Email: ${lead.email}`)
  if (lead.vacante) descLines.push(`Vacante: ${lead.vacante}`)
  if (lead.monto) descLines.push(`Monto propuesto: $${Number(lead.monto).toLocaleString('es-MX')}`)
  if (lead.notas) descLines.push(`\nNotas:\n${lead.notas}`)
  descLines.push('\n— Generado automáticamente por Chambas CRM tras enviar presentación.')

  const body = {
    summary: followUpTitle(lead),
    description: descLines.join('\n'),
    start: { date: startDate },
    end:   { date: endDate },
    // FIX (8-jun-2026): transparent = NO bloquea calendario.
    // Si dejábamos opaque (default), Vambe / Calendly / Cal.com veían el día
    // como "busy" y rechazaban agendar llamadas — caso Sandra Monjaras
    // +5214281123167. Estos son recordatorios, no eventos que ocupen tiempo.
    transparency: 'transparent',
    visibility: 'private',
    // Recordatorios populares 1 día antes + el mismo día a las 9am
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 24 * 60 },          // 1 día antes
        { method: 'popup', minutes: 0 },                // mismo día (00:00)
      ],
    },
  }

  const result = await calendarFetch(supabase, 'POST', '/calendars/{calendarId}/events', body) as { id?: string }
  return result?.id || ''
}

export async function deleteFollowUpReminder(supabase: Supabase, eventId: string): Promise<void> {
  await deleteCalendarEvent(supabase, eventId)
}

export async function isConnected(supabase: Supabase): Promise<{ connected: boolean; google_email: string | null }> {
  const { data } = await supabase
    .from('google_calendar_tokens').select('google_email').eq('user_id', USER_ID).single()
  return { connected: !!data, google_email: data?.google_email || null }
}

// ─── Import eventos del Calendar al CRM ─────────────────────────────────
type GCalEvent = {
  id: string
  summary?: string
  description?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: Array<{ email?: string; responseStatus?: string }>
  organizer?: { email?: string }
  status?: string
}

export async function listUpcomingEvents(supabase: Supabase, daysAhead = 30): Promise<GCalEvent[]> {
  const now = new Date()
  const future = new Date(now.getTime() + daysAhead * 86400_000)
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  })
  const result = await calendarFetch(supabase, 'GET', `/calendars/{calendarId}/events?${params}`)
  return (result?.items || []) as GCalEvent[]
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g
// Acepta teléfonos mexicanos con o sin +52, con o sin espacios — 10 dígitos mínimo.
const PHONE_RE = /(?:\+?52\s*)?(?:\d[\s-]?){10,15}\d/

/**
 * Parsea la info del cliente desde el evento.
 *
 * Soporta los 3 patrones reales que aparecen:
 *
 *  (A) Google Appointment Scheduler / onboarding — sección "Booked by" en description:
 *
 *        Booked by
 *        Guadalupe Pérez González
 *        luisantoniocp27@gmail.com
 *        5576725706
 *
 *  (B) Eventos de Vambe — formato del título:
 *        "Nombre <> Llamada ChambasAI <> Nombre +5215517282187"
 *      El nombre + teléfono viven en el título; el email del attendee a veces
 *      no es del cliente (puede ser un email random del invite).
 *
 *  (C) Llamada genérica desde onboarding:
 *        "Llamada - Vendedor (gabriela arias)"
 *      Solo nombre en el título — sin teléfono ni email directo.
 *
 * Para evitar matchear con attendees random, intentamos PRIMERO el teléfono
 * del título (cuando hay) y solo si no hay, vamos al email.
 */
type ClientInfo = {
  email: string | null
  nombre: string | null
  telefono: string | null
}

/** Lista de emails que NO son del cliente (owner del calendar + organizer del evento). */
function getOwnerEmails(ev: GCalEvent, ownerEmail: string | null): Set<string> {
  const owners = new Set<string>()
  if (ownerEmail) owners.add(ownerEmail.toLowerCase())
  if (ev.organizer?.email) owners.add(ev.organizer.email.toLowerCase())
  // Hardcoded fallbacks por si el OAuth quedó con google_email vacío.
  owners.add('fer@chambas.ai')
  owners.add('max@chambas.ai')
  return owners
}

function extractClientFromEvent(ev: GCalEvent, ownerEmail: string | null): ClientInfo {
  const owners = getOwnerEmails(ev, ownerEmail)
  const desc = ev.description || ''
  const title = ev.summary || ''

  let nombre: string | null = null
  let email: string | null = null
  let telefono: string | null = null

  // 1. Booked by section (Appointment Scheduler — más confiable)
  const bookedByMatch = desc.match(/Booked by\s*\n([^\n]+)\s*\n?([^\n]*)\s*\n?([^\n]*)/i)
  if (bookedByMatch) {
    const lines = [bookedByMatch[1], bookedByMatch[2], bookedByMatch[3]].filter(Boolean).map(s => s.trim())
    for (const line of lines) {
      if (!email && EMAIL_RE.test(line)) email = (line.match(EMAIL_RE) || [])[0] || null
      else if (!telefono && PHONE_RE.test(line)) telefono = (line.match(PHONE_RE) || [])[0] || null
      else if (!nombre && line && !EMAIL_RE.test(line) && !PHONE_RE.test(line)) nombre = line
    }
  }

  // 2. Teléfono del título (formato Vambe: "Nombre <> ... <> Nombre +5215...")
  if (!telefono) {
    const m = title.match(PHONE_RE)
    if (m) telefono = m[0]
  }

  // 3. Nombre del título — múltiples patrones:
  if (!nombre) {
    //  3a. "Llamada - Vendedor (NOMBRE)" → captura entre paréntesis
    const m1 = title.match(/\(([^)]+)\)\s*$/)
    if (m1) nombre = m1[1].trim()
    else {
      //  3b. Vambe: "Nombre <> Llamada ChambasAI <> ..." → tomar primer segmento antes de <>
      const m2 = title.match(/^([^<>]+?)\s*<>/)
      if (m2) nombre = m2[1].trim()
      else {
        //  3c. "Llamada - Nombre 525543814663" → texto entre "Llamada -" y un teléfono
        const m3 = title.match(/Llamada\s*[-—]\s*([^\d+]+?)(?:\s+\+?\d|$)/i)
        if (m3) nombre = m3[1].trim()
      }
    }
  }

  // 4. Email del attendee — solo si NO es de un owner conocido
  if (!email) {
    for (const a of ev.attendees || []) {
      if (a.email && !owners.has(a.email.toLowerCase())) {
        email = a.email
        break
      }
    }
  }

  // 5. Fallback: cualquier email en title/description (excluyendo owners)
  if (!email) {
    const text = `${title}\n${desc}`
    const matches = text.match(EMAIL_RE) || []
    for (const m of matches) {
      if (!owners.has(m.toLowerCase())) { email = m; break }
    }
  }

  // 6. Teléfono fallback desde description completa
  if (!telefono) {
    const m = desc.match(PHONE_RE)
    if (m) telefono = m[0]
  }

  return {
    email: email ? email.toLowerCase() : null,
    nombre,
    telefono: telefono ? telefono.replace(/[\s-+]/g, '') : null,
  }
}

export type ImportResult = {
  events_scanned: number
  leads_matched: number
  leads_updated: number
  leads_created: number
  details: Array<{
    event_id: string
    title: string
    when: string
    matched_email: string | null
    lead_id: string | null
    lead_name: string | null
    action: 'updated' | 'created' | 'already_set' | 'no_email_found'
  }>
}

type LeadMatch = { id: string; email: string; nombre: string | null; telefono: string | null; status: string; llamada_at: string | null; google_calendar_event_id: string | null }

/**
 * Decide si un evento del Calendar es relevante para importar al CRM.
 *
 * Reglas:
 *  - EXCLUSIONES (gana sobre includes): eventos internos del equipo
 *    como "ChambasAI Ops & Growth", "Planning", "Review", "Standup",
 *    "1:1", "team", "sync interno", "reunión interna".
 *  - INCLUSIONES — un evento es relevante si:
 *      · Title incluye "llamada" (cubre "Llamada - Vendedor (X)",
 *        "Nombre <> Llamada ChambasAI <> Nombre +52...")
 *      · OR title incluye "vendedor"
 *      · OR description tiene "Booked by" (Google Appointment Scheduler / onboarding)
 *
 * NOTA: "Chambas" sin "Llamada" ya no es suficiente — eventos internos
 * como "ChambasAI Ops & Growth" lo contienen. Solo entran si el title
 * tiene "Llamada" explícitamente.
 */
const INTERNAL_KEYWORDS = [
  'ops & growth',
  'ops growth',
  'planning',
  'review',
  'standup',
  'stand-up',
  '1:1',
  '1 a 1',
  'team sync',
  'sync interno',
  'reunión interna',
  'reunion interna',
  'retro',
  'roadmap',
  'all hands',
  'all-hands',
]

export function isRelevantCalendarEvent(ev: GCalEvent): boolean {
  if (ev.status === 'cancelled') return false
  if (!ev.start?.dateTime) return false  // skip all-day events
  const title = (ev.summary || '').toLowerCase()
  const desc = (ev.description || '').toLowerCase()

  // Exclude internal team events first
  if (INTERNAL_KEYWORDS.some(k => title.includes(k))) return false

  // Includes — solo si hay señal clara de que es una llamada comercial
  if (title.includes('llamada') || title.includes('vendedor')) return true
  if (desc.includes('booked by')) return true
  return false
}

export async function importEventsToLeads(supabase: Supabase): Promise<ImportResult> {
  const auth = await getValidAccessToken(supabase)
  if (!auth) throw new Error('Google Calendar no conectado')

  const events = await listUpcomingEvents(supabase, 30)
  // Filtro relevancia: solo eventos que parecen llamadas comerciales / onboarding
  const valid = events.filter(isRelevantCalendarEvent)

  const result: ImportResult = {
    events_scanned: valid.length,
    leads_matched: 0,
    leads_updated: 0,
    leads_created: 0,
    details: [],
  }

  // Pre-fetch todos los leads para matching por email Y por teléfono (last-10)
  const { data: allLeads } = await supabase
    .from('leads').select('id, email, nombre, telefono, status, llamada_at, google_calendar_event_id')
  const leadsByEmail = new Map<string, LeadMatch>()
  const leadsByPhoneLast10 = new Map<string, LeadMatch>()
  for (const l of (allLeads || []) as LeadMatch[]) {
    if (l.email) leadsByEmail.set(l.email.toLowerCase(), l)
    if (l.telefono) {
      const last10 = l.telefono.replace(/\D/g, '').slice(-10)
      if (last10.length === 10) leadsByPhoneLast10.set(last10, l)
    }
  }

  const STAGES_TO_ADVANCE = new Set(['nuevo', 'contactado', 'no_show_llamada'])

  for (const ev of valid) {
    const when = ev.start?.dateTime || ''
    const client = extractClientFromEvent(ev, auth.googleEmail)

    // Match en orden de confianza:
    //   1. Por teléfono (last10) — el más confiable cuando viene del título Vambe.
    //   2. Por email — cuando no hay teléfono o no matchea por teléfono.
    let matchedLead: LeadMatch | undefined
    if (client.telefono) {
      const last10 = client.telefono.replace(/\D/g, '').slice(-10)
      if (last10.length === 10) matchedLead = leadsByPhoneLast10.get(last10)
    }
    if (!matchedLead && client.email) {
      matchedLead = leadsByEmail.get(client.email)
    }

    // Si no encontramos NI email NI lead por teléfono, no podemos hacer nada
    if (!matchedLead && !client.email) {
      result.details.push({
        event_id: ev.id, title: ev.summary || '(sin título)', when,
        matched_email: null, lead_id: null, lead_name: client.nombre,
        action: 'no_email_found',
      })
      continue
    }

    // Si no matcheamos por teléfono y tampoco encontramos lead por email,
    // tendremos que crear uno nuevo abajo (rama else).

    if (matchedLead) {
      result.leads_matched += 1

      // Si ya tiene este event_id y llamada_at, skip
      const alreadyLinked = matchedLead.google_calendar_event_id === ev.id
        && matchedLead.llamada_at === when
      if (alreadyLinked) {
        result.details.push({
          event_id: ev.id, title: ev.summary || '(sin título)', when,
          matched_email: client.email, lead_id: matchedLead.id, lead_name: matchedLead.nombre,
          action: 'already_set',
        })
        continue
      }

      // Update: llamada_at + event_id + advance status si aplica
      const updates: Record<string, unknown> = {
        llamada_at: when,
        google_calendar_event_id: ev.id,
      }
      if (STAGES_TO_ADVANCE.has(matchedLead.status)) {
        updates.status = 'llamada_agendada'
        updates.status_changed_at = new Date().toISOString()
      }
      // Si el lead no tiene nombre/telefono y el evento sí, llenarlos
      if (!matchedLead.nombre && client.nombre) updates.nombre = client.nombre
      if (!matchedLead.telefono && client.telefono) updates.telefono = client.telefono

      await supabase.from('leads').update(updates).eq('id', matchedLead.id)
      await supabase.from('lead_actividad').insert({
        lead_id: matchedLead.id,
        tipo: 'field_change',
        descripcion: `Llamada importada del Calendar: ${new Date(when).toLocaleString('es-MX')}${updates.status ? ` · status → llamada_agendada` : ''}`,
        metadata: { source: 'calendar_import', event_id: ev.id, when, status_advanced: !!updates.status },
      })
      result.leads_updated += 1
      result.details.push({
        event_id: ev.id, title: ev.summary || '(sin título)', when,
        matched_email: client.email, lead_id: matchedLead.id, lead_name: matchedLead.nombre,
        action: 'updated',
      })
    } else {
      // No existe el lead — crearlo con los datos del evento.
      // Necesitamos email obligatoriamente (es la PK lógica del lead). Si llegamos
      // aquí sin email, ya pasó el check de arriba, pero por TS narrowing y
      // defensa: re-validamos.
      const clientEmail = client.email
      if (!clientEmail) {
        result.details.push({
          event_id: ev.id, title: ev.summary || '(sin título)', when,
          matched_email: null, lead_id: null, lead_name: client.nombre,
          action: 'no_email_found',
        })
        continue
      }

      const { data: newLead, error } = await supabase.from('leads').insert({
        email: clientEmail,
        nombre: client.nombre,
        telefono: client.telefono,
        canal_adquisicion: 'Calendar booking',
        status: 'llamada_agendada',
        llamada_at: when,
        google_calendar_event_id: ev.id,
        veces_contactado: 0,
        monto: 1160,
      }).select('id').single()

      if (error) {
        // Email puede ser duplicado por otro lead — log y continuar
        result.details.push({
          event_id: ev.id, title: ev.summary || '(sin título)', when,
          matched_email: clientEmail, lead_id: null, lead_name: client.nombre,
          action: 'no_email_found',  // técnicamente fue error, pero usamos este flag
        })
        continue
      }

      if (newLead) {
        await supabase.from('lead_actividad').insert({
          lead_id: newLead.id,
          tipo: 'field_change',
          descripcion: `Lead creado desde Calendar booking — llamada agendada ${new Date(when).toLocaleString('es-MX')}`,
          metadata: { source: 'calendar_import', event_id: ev.id, when, created: true },
        })
        // Agregarlo al map por si otro evento del mismo email viene después
        leadsByEmail.set(clientEmail, {
          id: newLead.id, email: clientEmail, nombre: client.nombre,
          telefono: client.telefono, status: 'llamada_agendada',
          llamada_at: when, google_calendar_event_id: ev.id,
        })
        result.leads_created += 1
        result.details.push({
          event_id: ev.id, title: ev.summary || '(sin título)', when,
          matched_email: clientEmail, lead_id: newLead.id, lead_name: client.nombre,
          action: 'created',
        })
      }
    }
  }
  return result
}

// ─── Dedupe de eventos de llamada (anti-duplicados Vambe) ───────────────
//
// Contexto del bug: cuando un lead reagenda con el bot Vambe, Vambe crea
// un evento nuevo en GCal pero el evento viejo NO se borra (Vambe no le
// pasa el `event_id` previo al webhook stage.changed, y el CRM tampoco
// llama a syncLeadToCalendar desde el webhook — solo actualiza
// `llamada_at` en DB). Resultado: 2+ eventos visibles en GCal para el
// mismo lead, confunde a quien lee la agenda.
//
// Las funciones de abajo permiten al webhook (o a un cron) listar todos
// los eventos futuros del calendario que matcheen a un lead (por teléfono
// o nombre) y borrar los que NO correspondan a la `llamada_at` actual
// del lead — dejando un solo evento "canónico" por lead.

type GCalListedEvent = {
  id: string
  summary?: string
  description?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  status?: string
}

/**
 * Lista eventos futuros de Calendar que matcheen al lead por teléfono
 * o nombre (usando el query `q` de la Calendar API que busca en title +
 * description). Excluye eventos cancelled.
 */
export async function listFutureEventsForLead(
  supabase: Supabase,
  lead: Pick<Lead, 'nombre' | 'telefono'>,
  options: { fromIso?: string; maxResults?: number } = {},
): Promise<GCalListedEvent[]> {
  const fromIso = options.fromIso || new Date().toISOString()
  const maxResults = options.maxResults || 50
  // Preferimos buscar por teléfono — es más único que el nombre.
  const q = (lead.telefono || lead.nombre || '').trim()
  if (!q) return []
  const params = new URLSearchParams({
    q,
    timeMin: fromIso,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  })
  try {
    const result = await calendarFetch(supabase, 'GET', `/calendars/{calendarId}/events?${params}`)
    const items = ((result as { items?: GCalListedEvent[] })?.items || [])
      .filter(e => e.status !== 'cancelled')
    return items
  } catch (e) {
    console.error('[listFutureEventsForLead] failed:', e)
    return []
  }
}

/**
 * Para un lead que acaba de agendar una nueva llamada con `keepLlamadaAt`,
 * lista todos los eventos futuros que matchean (por teléfono o nombre)
 * y deja UN SOLO evento canónico.
 *
 * Estrategia de elección del winner (en orden de preferencia):
 *   1. Evento cuyo start coincide con `keepLlamadaAt` dentro de tolerancia
 *      (default 2 min). Es el "agendado real" según Vambe.
 *   2. Si no hay match exacto pero hay >1 evento futuro, ganamos el MÁS
 *      CERCANO temporalmente a `keepLlamadaAt` (cualquier delta). Esto cubre
 *      los casos en que Vambe creó/movió el evento y el start no coincide
 *      exactamente con el llamada_at del CRM (skew de zona horaria, edits
 *      manuales en GCal, etc).
 *   3. Si solo hay 1 evento futuro, ese gana y no borra nada (ya está limpio).
 *
 * Bug previo (fixed 24-jun-2026 por reporte de Fer / caso Maricela):
 *   antes, si no había winner exacto en la tolerancia de 2 min, NO borraba
 *   nada y los duplicados quedaban en GCal para siempre. Ahora SIEMPRE
 *   colapsa a un solo evento — la regla del user es "solo la última agenda
 *   confirmada".
 *
 * Devuelve {keptEventId, deleted, totalFound}.
 */
export async function dedupeFutureCallEventsForLead(
  supabase: Supabase,
  lead: Pick<Lead, 'nombre' | 'telefono'>,
  keepLlamadaAt: string,
  options: { toleranceMs?: number } = {},
): Promise<{ keptEventId: string | null; deleted: string[]; totalFound: number }> {
  const TOLERANCE_MS = options.toleranceMs ?? 2 * 60_000  // 2 minutos default
  const events = await listFutureEventsForLead(supabase, lead)
  if (events.length === 0) return { keptEventId: null, deleted: [], totalFound: 0 }
  if (events.length === 1) return { keptEventId: events[0].id, deleted: [], totalFound: 1 }

  const targetMs = new Date(keepLlamadaAt).getTime()

  // Paso 1: buscar match exacto dentro de tolerancia
  let winner: GCalListedEvent | null = null
  let winnerDelta = Infinity
  for (const ev of events) {
    const startStr = ev.start?.dateTime || ev.start?.date
    if (!startStr) continue
    const delta = Math.abs(new Date(startStr).getTime() - targetMs)
    if (delta < winnerDelta && delta <= TOLERANCE_MS) {
      winner = ev
      winnerDelta = delta
    }
  }

  // Paso 2: si no hay match exacto, tomamos el MÁS CERCANO temporalmente.
  // Esto cubre el caso en que Vambe creó el nuevo evento con un start un
  // poco distinto al llamada_at del CRM, o el lead reagendó y el llamada_at
  // del CRM aún no se sincronizó pero los eventos GCal sí.
  if (!winner) {
    for (const ev of events) {
      const startStr = ev.start?.dateTime || ev.start?.date
      if (!startStr) continue
      const delta = Math.abs(new Date(startStr).getTime() - targetMs)
      if (delta < winnerDelta) {
        winner = ev
        winnerDelta = delta
      }
    }
  }

  if (!winner) {
    // No deberíamos llegar acá si events.length>0, pero por seguridad
    return { keptEventId: null, deleted: [], totalFound: events.length }
  }

  // Borrar todos los eventos del lead que NO sean el winner
  const deleted: string[] = []
  for (const ev of events) {
    if (ev.id === winner.id) continue
    try {
      await deleteCalendarEvent(supabase, ev.id)
      deleted.push(ev.id)
    } catch (e) {
      console.error(`[dedupeFutureCallEventsForLead] no se pudo borrar ${ev.id}:`, e)
    }
  }

  return { keptEventId: winner.id, deleted, totalFound: events.length }
}
