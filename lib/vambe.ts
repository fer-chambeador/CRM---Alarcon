import type { Lead } from './supabase'

/**
 * Vambe API client — chat AI por WhatsApp/Webchat/Email.
 *
 * Docs: https://docs.vambe.me/
 * API base: https://api.vambe.me
 * Auth: header `x-api-key`
 *
 * Env vars requeridas:
 *  - VAMBE_API_KEY              (Dashboard → Developers → API Keys)
 *  - VAMBE_CHANNEL_PHONE        (tu número de WhatsApp del cual envía Vambe, ej. +525511223344)
 *  - VAMBE_WELCOME_TEMPLATE_ID  (template ID de WhatsApp para mandar a leads nuevos)
 *  - VAMBE_STAGE_NEW            (opcional, stage_id de "Nuevo" en tu pipeline de Vambe)
 *  - VAMBE_AGENT_ID             (opcional, agent_id default al crear contact)
 */

const API_BASE = 'https://api.vambe.me'

function getKey(): string {
  const k = process.env.VAMBE_API_KEY
  if (!k) throw new Error('VAMBE_API_KEY no configurada')
  return k
}

async function vambeFetch(method: string, path: string, opts: {
  body?: unknown
  query?: Record<string, string | undefined>
  headerKey?: boolean   // true = pasa x-api-key como header (default). false = como query param.
} = {}): Promise<unknown> {
  const apiKey = getKey()
  const url = new URL(`${API_BASE}${path}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, v)
    }
  }
  if (opts.headerKey === false) {
    url.searchParams.set('x-api-key', apiKey)
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.headerKey !== false) headers['x-api-key'] = apiKey

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Vambe ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('json')) return res.json()
  return res.text()
}

// ─── Contact upsert ─────────────────────────────────────────────────────
export type UpsertContactInput = {
  phone: string
  email?: string | null
  nombre?: string | null
  empresa?: string | null
  vacante?: string | null
  presupuesto?: string | null
  canal_adquisicion?: string | null
  puesto?: string | null
  notas?: string | null
  lead_id?: string  // crm lead id, lo guardamos como metadata
}
export type UpsertContactResult = {
  ai_contact_id?: string
  raw: unknown
}

/** Normaliza teléfono al formato E.164 con prefijo +52 si no tiene. */
function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-()]/g, '')
  if (cleaned.startsWith('+')) return cleaned
  // México por default
  if (cleaned.length === 10) return `+52${cleaned}`
  return `+${cleaned}`
}

export async function upsertContact(input: UpsertContactInput): Promise<UpsertContactResult> {
  const channelPhone = process.env.VAMBE_CHANNEL_PHONE
  if (!channelPhone) throw new Error('VAMBE_CHANNEL_PHONE no configurada')

  const meta: Record<string, unknown> = { source: 'chambas-crm' }
  if (input.canal_adquisicion) meta.canal_adquisicion = input.canal_adquisicion
  if (input.empresa) meta.empresa = input.empresa
  if (input.vacante) meta.vacante = input.vacante
  if (input.presupuesto) meta.presupuesto = input.presupuesto
  if (input.puesto) meta.puesto = input.puesto
  if (input.notas) meta.notas_iniciales = input.notas
  if (input.lead_id) meta.crm_lead_id = input.lead_id

  const body: Record<string, unknown> = {
    channel: 'whatsapp',
    channel_phone_number: channelPhone,
    contact_phone_number: normalizePhone(input.phone),
    meta_data: meta,
  }
  if (input.email) body.contact_email = input.email
  if (input.nombre) body.contact_name = input.nombre
  if (process.env.VAMBE_AGENT_ID) body.agentId = process.env.VAMBE_AGENT_ID
  if (process.env.VAMBE_STAGE_NEW) body.stageId = process.env.VAMBE_STAGE_NEW

  const raw = await vambeFetch('POST', '/api/public/customer/upsert/info', { body }) as {
    aiContactId?: string
    ai_contact_id?: string
    id?: string
  }
  const ai_contact_id = raw?.aiContactId || raw?.ai_contact_id || raw?.id
  return { ai_contact_id, raw }
}

// ─── Send template ──────────────────────────────────────────────────────
export async function sendTemplate(params: {
  phone: string
  templateId: string
  data?: Record<string, unknown>
  stageId?: string
}): Promise<unknown> {
  const channelPhone = process.env.VAMBE_CHANNEL_PHONE
  if (!channelPhone) throw new Error('VAMBE_CHANNEL_PHONE no configurada')
  const fromPhone = channelPhone

  // Query params: x-api-key (en query, no header) y from-phone-number
  return vambeFetch('POST', `/api/public/whatsapp/message/send/template/${encodeURIComponent(params.templateId)}`, {
    headerKey: false,
    query: {
      'from-phone-number': fromPhone,
      stage: params.stageId,
    },
    body: {
      phone_number: normalizePhone(params.phone),
      ...(params.data || {}),
    },
  })
}

// ─── List templates ─────────────────────────────────────────────────────
//
// Vambe no permite CREAR templates por API (Meta los aprueba en el dashboard
// de Vambe). Solo se pueden listar y enviar.
export type VambeTemplate = {
  id: string
  name?: string
  status?: string                    // APPROVED / PENDING / REJECTED
  category?: string                  // UTILITY / MARKETING / AUTHENTICATION
  language?: string                  // es / en / es_MX
  channel_type?: string              // whatsapp / instagram / etc
  body?: string                      // texto del template con variables {{1}}, {{2}}, …
  variables?: string[]               // nombres de variables si Vambe los provee
  components?: unknown               // raw components del template (header/body/footer/buttons)
  created_at?: string
  updated_at?: string
  // Permitimos pasar campos extra de la respuesta tal cual
  [k: string]: unknown
}

export type ListTemplatesParams = {
  page?: number
  name?: string
  status?: string
  category?: string
  language?: string
  channel_type?: 'whatsapp' | 'web-whatsapp' | 'instagram' | 'webchat' | 'messenger' | 'email' | 'sms'
  get_all?: boolean
}

export async function listTemplates(params: ListTemplatesParams = {}): Promise<{ templates: VambeTemplate[]; raw: unknown }> {
  const query: Record<string, string | undefined> = {
    page: params.page ? String(params.page) : undefined,
    name: params.name,
    status: params.status,
    category: params.category,
    language: params.language,
    channel_type: params.channel_type,
    get_all: params.get_all ? 'true' : undefined,
  }
  const raw = await vambeFetch('GET', '/api/public/templates', { query }) as
    | { templates?: VambeTemplate[]; data?: VambeTemplate[]; items?: VambeTemplate[] }
    | VambeTemplate[]
  let templates: VambeTemplate[] = []
  if (Array.isArray(raw)) templates = raw
  else templates = raw?.templates || raw?.data || raw?.items || []
  return { templates, raw }
}

// ─── Send template (bulk, unstructured) ─────────────────────────────────
/**
 * Envía un template a múltiples contactos en una sola llamada.
 * Cada item del array debe traer al menos `phone_number` + variables.
 * Vambe AI mapea las variables automáticamente.
 */
export async function sendTemplateBulk(params: {
  templateId: string
  items: Array<Record<string, unknown>>   // cada item: { phone_number, ...vars }
  stageId?: string
}): Promise<unknown> {
  const channelPhone = process.env.VAMBE_CHANNEL_PHONE
  if (!channelPhone) throw new Error('VAMBE_CHANNEL_PHONE no configurada')

  // Normalizar phone_number en cada item
  const items = params.items.map(it => {
    const phone = (it.phone_number || it.phone || '') as string
    return { ...it, phone_number: phone ? normalizePhone(phone) : phone }
  })

  return vambeFetch('POST', `/api/public/whatsapp/message/send/template/${encodeURIComponent(params.templateId)}/many`, {
    headerKey: false,
    query: {
      'from-phone-number': channelPhone,
      stage: params.stageId,
    },
    body: items,
  })
}

// ─── Get contacts by days (filtrable por stage_id) ─────────────────────
export type VambeContact = {
  id: string                              // = aiContactId
  name?: string
  phone?: string
  email?: string
  platform?: string
  last_message_at?: string
  chat_status?: string
  created_at?: string
  default_stage_id?: string | null
  active_ticket_v2?: { id?: string; current_stage_id?: string | null } | null
  [k: string]: unknown
}

export async function getContactsByDays(params: {
  days: number
  stageId?: string
  pipelineId?: string
}): Promise<VambeContact[]> {
  const query: Record<string, string | undefined> = {
    days: String(params.days),
    stage_id: params.stageId,
    pipeline_id: params.pipelineId,
  }
  const raw = await vambeFetch('GET', '/api/public/contacts', { query }) as
    | { contacts?: VambeContact[]; data?: VambeContact[] }
    | VambeContact[]
  if (Array.isArray(raw)) return raw
  return raw?.contacts || raw?.data || []
}

// ─── List pipelines (incluye stages) ────────────────────────────────────
export type VambePipeline = {
  id: string
  name?: string
  stages?: Array<{ id: string; name?: string }>
  [k: string]: unknown
}

export async function listPipelines(): Promise<{ pipelines: VambePipeline[]; raw: unknown }> {
  const raw = await vambeFetch('GET', '/api/public/pipeline') as
    | { pipelines?: VambePipeline[]; data?: VambePipeline[] }
    | VambePipeline[]
  let pipelines: VambePipeline[] = []
  if (Array.isArray(raw)) pipelines = raw
  else pipelines = raw?.pipelines || raw?.data || []
  return { pipelines, raw }
}

// ─── Send raw message (no template) ─────────────────────────────────────
export async function sendMessage(params: {
  phone: string
  message: string
}): Promise<unknown> {
  const channelPhone = process.env.VAMBE_CHANNEL_PHONE
  if (!channelPhone) throw new Error('VAMBE_CHANNEL_PHONE no configurada')
  return vambeFetch('POST', '/api/public/web-whatsapp/message/send', {
    body: {
      from_phone_number: channelPhone,
      to_phone_number: normalizePhone(params.phone),
      message: params.message,
    },
  })
}

// ─── Get conversation messages ───────────────────────────────────────────
export type VambeMessage = {
  id: string
  message: string
  from_number?: string
  to_number?: string
  direction: 'inbound' | 'outbound'
  created_at: string
  message_type?: string
  status?: string
}

export async function getMessages(aiContactId: string, limit = 50): Promise<VambeMessage[]> {
  const raw = await vambeFetch('GET', `/api/public/contact/${aiContactId}/messages`, {
    query: { limit: String(limit) },
  }) as { messages?: unknown[]; data?: unknown[] } | unknown[]
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (raw?.messages || raw?.data || [])

  // Normalizar: Vambe puede usar `message`, `text`, `content`, `body` (o variantes).
  // Buscar en todos los campos comunes y devolver siempre con `message` poblado.
  return list.map(m => {
    const r = m as Record<string, unknown>
    const candidates = [
      r.message, r.text, r.content, r.body,
      r.message_text, r.content_text, r.text_content,
      // Algunas APIs anidan: data.message o payload.text
      (r.data as Record<string, unknown> | undefined)?.message,
      (r.data as Record<string, unknown> | undefined)?.text,
      (r.payload as Record<string, unknown> | undefined)?.text,
      (r.payload as Record<string, unknown> | undefined)?.body,
    ]
    const msg = candidates.find(v => typeof v === 'string' && v.length > 0) as string | undefined
    return {
      ...(r as object),
      message: msg || '',
    } as VambeMessage
  })
}

// ─── Webhook helpers ─────────────────────────────────────────────────────
export type VambeWebhookEvent = {
  type: string  // 'message.received' | 'message.sent' | 'ticket.created' | 'ticket.closed' | 'stage.changed' | etc
  aiContactId?: string
  data?: Record<string, unknown>
  event?: string  // a veces usan event en lugar de type
  timestamp?: string
}

/**
 * Crear webhook subscription en Vambe (idempotente — solo crear si no existe).
 * Lo llamás una vez desde la UI o un script de setup.
 */
export async function createWebhook(url: string, topics: string[]): Promise<unknown> {
  return vambeFetch('POST', '/api/webhooks', {
    body: { url, topics, active: true, description: 'Chambas CRM' },
  })
}

export async function listWebhooks(): Promise<unknown> {
  return vambeFetch('GET', '/api/webhooks')
}

// ─── Search contact by phone/email ───────────────────────────────────────
export async function searchContact(query: { phone?: string; email?: string }): Promise<{ ai_contact_id: string | null }> {
  const params = new URLSearchParams()
  if (query.phone) params.set('phone', normalizePhone(query.phone))
  if (query.email) params.set('email', query.email)
  try {
    const raw = await vambeFetch('GET', `/api/public/contact/search?${params}`) as {
      contacts?: Array<{ id?: string; aiContactId?: string }>
      ai_contact_id?: string
      id?: string
    }
    const first = raw?.contacts?.[0]
    return { ai_contact_id: first?.aiContactId || first?.id || raw?.ai_contact_id || raw?.id || null }
  } catch {
    return { ai_contact_id: null }
  }
}

// ─── Parser del mensaje del formulario ─────────────────────────────────
//
// El mensaje viene tipo:
//   ¡Hola! Completé el formulario...
//   ¿cuántasvacantepublicasalmes?: 10
//   ¿cuántoinviertesenreclutamientomensualmente?: $0 - $1,000
//   ¿quépuestosnecesitas_reclutar?: guardias de seguridad privada
//   full_name: Reyes Mariedla
//   phone: +525530361556
//   ¿cuáldescribemejortusituación_actual?: Recluto o gestiono personal...
//   email: foo@bar.com
//   inbox_url: ...
//
// Parseamos los campos "key: value" robustamente (ignorando emojis, acentos,
// espacios y la "¿" inicial).

export type FormFields = {
  nombre?: string
  email?: string
  telefono?: string
  vacante?: string
  presupuesto?: 'none' | '100_to_1000' | '2000_to_5000' | '10000_plus'
  vacantes_por_mes?: string
  rol?: string
  inbox_url?: string
  raw?: Record<string, string>
}

const norm = (s: string) => s
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[¿?¡!]/g, '')
  .replace(/\s+/g, '')
  .replace(/[_-]/g, '')

function mapPresupuesto(raw: string): FormFields['presupuesto'] {
  if (!raw) return undefined
  const lower = raw.toLowerCase()

  // Cualquier variante de "no invierto" cae en 'none'
  if (/no\s*(invier|invert|gast)/.test(lower)) return 'none'

  // Extraer todos los números del texto (manejando comas como miles)
  const numbers = (raw.match(/\d[\d,]*/g) || [])
    .map(n => parseInt(n.replace(/,/g, ''), 10))
    .filter(n => !isNaN(n))

  if (numbers.length === 0) return undefined

  // Si solo aparece "0" o "$0", también es 'none'
  if (numbers.every(n => n === 0)) return 'none'

  // Tomar el máximo para clasificar el bucket (cubre rangos tipo "$2,000 - $5,000")
  const max = Math.max(...numbers)

  if (max <= 1000) return '100_to_1000'
  if (max <= 5000) return '2000_to_5000'
  return '10000_plus'
}

/**
 * Detecta si un mensaje contiene el formulario y extrae los campos.
 * Retorna null si no detecta formato de formulario.
 *
 * Maneja dos formatos:
 *  - Multi-línea: cada `key: value` en su propia línea (formato canónico).
 *  - Inline:      todos los campos pegados en una sola línea separados por espacios.
 *                 Se inserta `\n` antes de cada `key:` candidato y se reintenta.
 */
export function parseFormMessage(text: string): FormFields | null {
  if (!text) return null

  // 1) Intento canónico: parsear tal cual viene
  const first = parseKeyValueLines(text)
  if (first) return first

  // 2) Fallback: inline single-line. Insertar `\n` antes de cada key candidato.
  //    Key candidato = `¿...?` o palabra ASCII (letras/dígitos/underscore),
  //    seguido de `:` y espacio. Idempotente con multi-línea (matchea \s+ incluido \n).
  const expanded = text.replace(/\s+([¿][^:]+?\?|[a-zA-Z][\w]+)\s*:\s*/g, '\n$1: ')
  return parseKeyValueLines(expanded)
}

function parseKeyValueLines(text: string): FormFields | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const kv: Record<string, string> = {}
  for (const line of lines) {
    const m = line.match(/^([^:]+?)\s*:\s*(.*)$/)
    if (!m) continue
    const key = norm(m[1])
    const value = m[2].trim()
    if (!key || !value) continue
    kv[key] = value
  }
  if (Object.keys(kv).length < 3) return null

  const out: FormFields = { raw: kv }

  for (const [k, v] of Object.entries(kv)) {
    if (!v) continue
    if (k === 'fullname' || k === 'nombre' || k === 'name') out.nombre = v
    else if (k === 'email' || k === 'correo') out.email = v.toLowerCase()
    else if (k === 'phone' || k === 'telefono' || k === 'celular' || k === 'whatsapp') out.telefono = v
    else if (k.includes('puesto') && k.includes('reclutar')) out.vacante = v
    else if (k.includes('vacante') && (k.includes('mes') || k.includes('publica'))) out.vacantes_por_mes = v
    else if (k.includes('invierte') || k.includes('presupuesto')) out.presupuesto = mapPresupuesto(v)
    else if (k.includes('describ') && k.includes('situacion')) out.rol = v
    else if (k === 'inboxurl' || k.includes('inbox')) out.inbox_url = v
  }

  if (!out.nombre && !out.email && !out.telefono) return null
  return out
}

// ─── High-level: sync lead → Vambe (upsert + opcionalmente send welcome) ─
export async function syncLeadToVambe(lead: Pick<Lead, 'id' | 'email' | 'nombre' | 'telefono' | 'empresa' | 'vacante' | 'presupuesto' | 'canal_adquisicion' | 'puesto' | 'notas'>, opts: { sendWelcome?: boolean } = {}): Promise<{
  ok: boolean
  ai_contact_id: string | null
  welcome_sent: boolean
  error?: string
}> {
  if (!lead.telefono) {
    return { ok: false, ai_contact_id: null, welcome_sent: false, error: 'lead sin teléfono' }
  }
  try {
    const { ai_contact_id } = await upsertContact({
      phone: lead.telefono,
      email: lead.email,
      nombre: lead.nombre,
      empresa: lead.empresa,
      vacante: lead.vacante,
      presupuesto: lead.presupuesto,
      canal_adquisicion: lead.canal_adquisicion,
      puesto: lead.puesto,
      notas: lead.notas,
      lead_id: lead.id,
    })

    let welcome_sent = false
    if (opts.sendWelcome && process.env.VAMBE_WELCOME_TEMPLATE_ID) {
      try {
        await sendTemplate({
          phone: lead.telefono,
          templateId: process.env.VAMBE_WELCOME_TEMPLATE_ID,
          data: {
            nombre: lead.nombre || 'amigo',
            empresa: lead.empresa || '',
            vacante: lead.vacante || '',
          },
        })
        welcome_sent = true
      } catch (e) {
        // Welcome failure no rompe el upsert
        console.error('Vambe welcome template falló:', e)
      }
    }

    return { ok: true, ai_contact_id: ai_contact_id || null, welcome_sent }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, ai_contact_id: null, welcome_sent: false, error: msg }
  }
}
