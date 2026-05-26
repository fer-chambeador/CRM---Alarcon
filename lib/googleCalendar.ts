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
