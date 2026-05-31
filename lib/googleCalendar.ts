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
const PHONE_RE = /(?:\+?52\s*)?(?:\d[\s-]?){10,15}\d/

/**
 * Parsea la info del cliente desde el evento.
 *
 * El appointment scheduler de Google Calendar mete una sección "Booked by:"
 * en la descripción con el nombre + email + teléfono del que agendó:
 *
 *   Booked by
 *   Guadalupe Pérez González
 *   luisantoniocp27@gmail.com
 *   5576725706
 *
 * También el nombre puede venir en el title como "Llamada - Vendedor (Nombre)".
 */
type ClientInfo = {
  email: string | null
  nombre: string | null
  telefono: string | null
}
function extractClientFromEvent(ev: GCalEvent, ownerEmail: string | null): ClientInfo {
  const owner = (ownerEmail || '').toLowerCase()
  const desc = ev.description || ''
  const title = ev.summary || ''

  // 1. Buscar "Booked by" section en la description
  const bookedByMatch = desc.match(/Booked by\s*\n([^\n]+)\s*\n?([^\n]*)\s*\n?([^\n]*)/i)
  let nombre: string | null = null
  let email: string | null = null
  let telefono: string | null = null

  if (bookedByMatch) {
    // Las próximas 3 líneas después de "Booked by" usualmente son: nombre, email, teléfono
    const lines = [bookedByMatch[1], bookedByMatch[2], bookedByMatch[3]].filter(Boolean).map(s => s.trim())
    for (const line of lines) {
      if (!email && EMAIL_RE.test(line)) email = (line.match(EMAIL_RE) || [])[0] || null
      else if (!telefono && PHONE_RE.test(line)) telefono = (line.match(PHONE_RE) || [])[0] || null
      else if (!nombre && line && !EMAIL_RE.test(line) && !PHONE_RE.test(line)) nombre = line
    }
  }

  // 2. Nombre desde el título: "Llamada - Vendedor (NOMBRE)"
  if (!nombre) {
    const m = title.match(/\(([^)]+)\)\s*$/)
    if (m) nombre = m[1].trim()
  }

  // 3. Email del attendee (que no sea el dueño del calendar)
  if (!email) {
    for (const a of ev.attendees || []) {
      if (a.email && a.email.toLowerCase() !== owner) {
        email = a.email
        break
      }
    }
  }

  // 4. Fallback: cualquier email en title/description
  if (!email) {
    const text = `${title}\n${desc}`
    const matches = text.match(EMAIL_RE) || []
    for (const m of matches) {
      if (m.toLowerCase() !== owner) { email = m; break }
    }
  }

  // 5. Teléfono fallback desde description completa
  if (!telefono) {
    const m = desc.match(PHONE_RE)
    if (m) telefono = m[0].replace(/[\s-]/g, '')
  }

  return {
    email: email ? email.toLowerCase() : null,
    nombre,
    telefono: telefono ? telefono.replace(/[\s-]/g, '') : null,
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
 * Filtro conservador para evitar que reuniones personales / 1:1s caigan al CRM.
 *
 * Considera relevante un evento si:
 *  - El título contiene "Llamada" o "Vendedor" o "Chambas" (case insensitive)
 *  - O la descripción tiene "Booked by" (formato del Google Appointment Scheduler / onboarding)
 *  - O la descripción menciona "Chambas Ay"
 *  - O fue creado por el Appointment Scheduler (organizer típico viene de calendars del scheduler)
 */
export function isRelevantCalendarEvent(ev: GCalEvent): boolean {
  if (ev.status === 'cancelled') return false
  if (!ev.start?.dateTime) return false  // skip all-day events
  const title = (ev.summary || '').toLowerCase()
  const desc = (ev.description || '').toLowerCase()
  if (title.includes('llamada') || title.includes('vendedor') || title.includes('chambas')) return true
  if (desc.includes('booked by') || desc.includes('chambas ay') || desc.includes('chambas')) return true
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

  // Pre-fetch todos los leads para matching
  const { data: allLeads } = await supabase
    .from('leads').select('id, email, nombre, telefono, status, llamada_at, google_calendar_event_id')
  const leadsByEmail = new Map<string, LeadMatch>()
  for (const l of (allLeads || []) as LeadMatch[]) {
    if (l.email) leadsByEmail.set(l.email.toLowerCase(), l)
  }

  const STAGES_TO_ADVANCE = new Set(['nuevo', 'contactado', 'no_show_llamada'])

  for (const ev of valid) {
    const when = ev.start?.dateTime || ''
    const client = extractClientFromEvent(ev, auth.googleEmail)

    // Si no encontramos email del cliente, no podemos hacer nada
    if (!client.email) {
      result.details.push({
        event_id: ev.id, title: ev.summary || '(sin título)', when,
        matched_email: null, lead_id: null, lead_name: client.nombre,
        action: 'no_email_found',
      })
      continue
    }

    const matchedLead = leadsByEmail.get(client.email)

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
      // No existe el lead — crearlo con los datos del evento
      const { data: newLead, error } = await supabase.from('leads').insert({
        email: client.email,
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
          matched_email: client.email, lead_id: null, lead_name: client.nombre,
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
        leadsByEmail.set(client.email, {
          id: newLead.id, email: client.email, nombre: client.nombre,
          telefono: client.telefono, status: 'llamada_agendada',
          llamada_at: when, google_calendar_event_id: ev.id,
        })
        result.leads_created += 1
        result.details.push({
          event_id: ev.id, title: ev.summary || '(sin título)', when,
          matched_email: client.email, lead_id: newLead.id, lead_name: client.nombre,
          action: 'created',
        })
      }
    }
  }
  return result
}
