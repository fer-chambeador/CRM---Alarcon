import { createServiceClient } from './supabase'
import { STATUS_ORDER } from './status'
import type { Lead } from './supabase'
import { sendTemplate, sendMessage, syncLeadToVambe } from './vambe'

/**
 * Tools que el asistente AI puede ejecutar contra la DB.
 *
 * Cada tool tiene:
 *  - definition: schema para mandar a Anthropic (tool use API)
 *  - executor: función real que corre contra Supabase
 *
 * El asistente decide cuándo y con qué args llamarlas. Devolvemos al
 * frontend la lista de acciones aplicadas para mostrar al user.
 */

const STATUS_LIST = STATUS_ORDER as readonly string[]

// ─── Tool definitions (lo que se manda a Anthropic) ────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'update_lead_status',
    description: 'Actualiza el status de UN lead específico, identificado por su email. Útil cuando el user pide cambiar un lead puntual.',
    input_schema: {
      type: 'object',
      properties: {
        lead_email: { type: 'string', description: 'Email exacto del lead (case-insensitive)' },
        new_status: { type: 'string', enum: [...STATUS_LIST], description: 'Nuevo status del lead' },
      },
      required: ['lead_email', 'new_status'],
    },
  },
  {
    name: 'bulk_update_status',
    description: `Actualiza el status de TODOS los leads que matchean un filtro. Útil para acciones masivas como "marca como descartado a todos los que llevan más de 30 días sin contactar".
IMPORTANTE: por default es dry-run (no aplica cambios, solo lista los afectados). Para aplicar de verdad, pasa confirm=true en una segunda llamada después de mostrar al user qué leads se modificarán.`,
    input_schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: 'Filtros para seleccionar leads. Combina los que apliquen.',
          properties: {
            current_status: { type: 'string', enum: [...STATUS_LIST], description: 'Status actual del lead' },
            canal: { type: 'string', description: 'Canal de adquisición (case-insensitive match parcial)' },
            min_days_in_stage: { type: 'number', description: 'Días mínimos en el stage actual (≥)' },
            max_days_in_stage: { type: 'number', description: 'Días máximos en el stage actual (≤)' },
            presupuesto: { type: 'string', enum: ['none', '100_to_1000', '2000_to_5000', '10000_plus'] },
          },
        },
        new_status: { type: 'string', enum: [...STATUS_LIST] },
        confirm: { type: 'boolean', description: 'false = dry-run (solo devuelve lista). true = aplica cambios.' },
      },
      required: ['filter', 'new_status'],
    },
  },
  {
    name: 'add_note_to_lead',
    description: 'Agrega o sobrescribe la nota de un lead.',
    input_schema: {
      type: 'object',
      properties: {
        lead_email: { type: 'string' },
        note: { type: 'string' },
        mode: { type: 'string', enum: ['append', 'overwrite'], description: 'append agrega al final con timestamp, overwrite reemplaza' },
      },
      required: ['lead_email', 'note'],
    },
  },
  {
    name: 'queue_vambe_calls',
    description: '[PLACEHOLDER, aún no implementado] Encola llamadas con Vambe AI para un set de leads. Por ahora solo loguea la intención — no llama de verdad. Cuando esté implementado, Vambe llamará automáticamente a los leads y devolverá calificación + resumen.',
    input_schema: {
      type: 'object',
      properties: {
        lead_emails: { type: 'array', items: { type: 'string' }, description: 'Emails de leads a llamar' },
        prompt: { type: 'string', description: 'Guion / contexto para el agente de Vambe' },
      },
      required: ['lead_emails'],
    },
  },
  {
    name: 'send_vambe_template',
    description: 'Envía un template de WhatsApp pre-aprobado vía Vambe a UN lead. Útil para mandar bienvenida, follow-up, recordatorio de propuesta, etc. El template_id se obtiene del dashboard de Vambe. Para mandar a varios leads, llamala N veces.',
    input_schema: {
      type: 'object',
      properties: {
        lead_email: { type: 'string', description: 'Email del lead destinatario' },
        template_id: { type: 'string', description: 'UUID del template en Vambe' },
        variables: { type: 'object', description: 'Variables del template (clave/valor)', additionalProperties: true },
      },
      required: ['lead_email', 'template_id'],
    },
  },
  {
    name: 'send_vambe_message',
    description: 'Envía un mensaje de WhatsApp directo (sin template) a un lead vía Vambe. Útil para responder ad-hoc o iniciar conversación con texto libre.',
    input_schema: {
      type: 'object',
      properties: {
        lead_email: { type: 'string' },
        message: { type: 'string', description: 'Texto del mensaje' },
      },
      required: ['lead_email', 'message'],
    },
  },
  {
    name: 'start_vambe_conversation',
    description: 'Para uno o varios leads: hace upsert en Vambe (si no existían) y opcionalmente manda un template de bienvenida. Útil cuando el user dice "arrancá conversación con X leads".',
    input_schema: {
      type: 'object',
      properties: {
        lead_emails: { type: 'array', items: { type: 'string' } },
        send_welcome: { type: 'boolean', description: 'Si true, manda el welcome template del CRM. Default true.' },
      },
      required: ['lead_emails'],
    },
  },
  {
    name: 'send_template_campaign',
    description: `Manda un template de Vambe a un segmento de leads. Útil cuando el user pide "manda el template X a los nuevos" o "manda follow-up a los que llevan 5 días sin contactar".
IMPORTANTE: por default DRY-RUN (solo cuenta). Para mandar de verdad, llamala una segunda vez con dry_run=false después de mostrar al user los conteos y que confirme.`,
    input_schema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'ID del template de Vambe' },
        template_name: { type: 'string', description: 'Nombre del template (para historial)' },
        segment: {
          type: 'object',
          description: 'Filtros del segmento (combinable)',
          properties: {
            status: { type: 'array', items: { type: 'string', enum: [...STATUS_LIST] } },
            canal: { type: 'array', items: { type: 'string' } },
            vacante_contains: { type: 'string' },
            min_dias_sin_contactar: { type: 'number' },
            max_dias_sin_contactar: { type: 'number' },
          },
        },
        override_vars: { type: 'object', description: 'Variables que se mandan a TODOS (ej. {"oferta": "20% off")}', additionalProperties: { type: 'string' } },
        dry_run: { type: 'boolean', description: 'false = manda de verdad. true (default) = solo cuenta.' },
      },
      required: ['template_id'],
    },
  },
  {
    name: 'query_campaigns',
    description: 'Consulta el historial de campañas enviadas. Útil cuando el user pregunta "cómo van las campañas", "cuál fue la última", "qué tasa de respuesta tuvo X".',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Cuántas devolver (max 20)', default: 10 },
      },
    },
  },
  {
    name: 'generate_file',
    description: `Genera un archivo descargable para el user. Úsalo cuando el user pida "dame CSV", "exporta a archivo", "descárgame la lista", etc. NO uses esta tool para mostrar info en pantalla — para eso solo respondé en markdown. Esta tool es específicamente para entregar un archivo que el user puede guardar.

Formatos soportados:
- CSV: separar columnas con coma, headers en la primera línea
- TXT: texto plano
- JSON: JSON válido

Después de llamar esta tool, el frontend muestra un botón "⇣ Descargar nombre.csv" al user.`,
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Nombre del archivo con extensión, ej. "leads-convertidos.csv"' },
        mime_type: { type: 'string', enum: ['text/csv', 'text/plain', 'application/json'], description: 'MIME type del archivo' },
        content: { type: 'string', description: 'Contenido completo del archivo como string. Para CSV incluí headers en la primera línea.' },
        description: { type: 'string', description: 'Descripción breve de qué tiene el archivo, ej. "61 leads convertidos con nombre, email, teléfono y monto"' },
      },
      required: ['filename', 'mime_type', 'content'],
    },
  },
  {
    name: 'list_leads_filtered',
    description: `Devuelve una lista de leads que matchean los filtros, ordenados por score descendente (los hot primero). Úsalo cuando el user pregunta cosas como:
- "¿qué leads calientes / hot debo contactar hoy?"
- "¿qué leads warm tengo en nuevo sin contactar?"
- "muéstrame los 10 mejores leads sin llamar"
- "qué leads de Vambe llegaron hoy"

Devuelve hasta 30 leads con nombre, empresa, teléfono, vacante, presupuesto, score, status y días desde creación. NO ejecuta acciones — solo lista para que el user decida.`,
    input_schema: {
      type: 'object',
      properties: {
        score_bucket: { type: 'string', enum: ['hot', 'warm', 'cold', 'any'], description: 'hot = score≥60 (alta calificación, manual). warm = 30-59. cold = <30. any = no filtrar.' },
        status: { type: 'string', enum: [...STATUS_LIST, 'any'], description: 'Filtrar por status del lead. "any" para no filtrar.' },
        canal: { type: 'string', description: 'Canal exacto (Vambe, Facebook, Calendar booking, etc) o substring' },
        created_within_days: { type: 'number', description: 'Solo leads creados en los últimos N días' },
        min_days_in_stage: { type: 'number', description: 'Días mínimos en el stage actual' },
        max_days_in_stage: { type: 'number', description: 'Días máximos en el stage actual' },
        limit: { type: 'number', description: 'Máximo de filas a devolver (default 20, máx 30)' },
      },
    },
  },
] as const

// ─── Result types ──────────────────────────────────────────────────────
export type ToolResult = {
  ok: boolean
  summary: string
  affected?: Array<{ id: string; email: string; nombre?: string | null }>
  data?: unknown
  error?: string
}

// ─── Executors ─────────────────────────────────────────────────────────
type Supabase = ReturnType<typeof createServiceClient>

async function execUpdateLeadStatus(input: { lead_email: string; new_status: Lead['status'] }, supabase: Supabase): Promise<ToolResult> {
  const { lead_email, new_status } = input
  if (!STATUS_LIST.includes(new_status)) {
    return { ok: false, summary: `Status inválido: ${new_status}`, error: 'invalid_status' }
  }
  const { data: lead } = await supabase
    .from('leads').select('id, email, nombre, status')
    .ilike('email', lead_email).single()
  if (!lead) return { ok: false, summary: `No se encontró lead con email ${lead_email}`, error: 'not_found' }

  // Usar el PATCH endpoint mismo en vez de update directo:
  // así se dispara la lógica de lead_actividad correctamente.
  const { error } = await supabase.from('leads')
    .update({ status: new_status })
    .eq('id', lead.id)
  if (error) return { ok: false, summary: error.message, error: error.message }

  await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'status_change',
    descripcion: `Status cambiado a: ${new_status}`,
    metadata: { source: 'asistente_ai', from: lead.status, to: new_status },
  })

  return {
    ok: true,
    summary: `Lead ${lead.nombre || lead.email} actualizado a ${new_status}`,
    affected: [{ id: lead.id, email: lead.email, nombre: lead.nombre }],
  }
}

async function execBulkUpdateStatus(input: {
  filter: {
    current_status?: Lead['status']
    canal?: string
    min_days_in_stage?: number
    max_days_in_stage?: number
    presupuesto?: Lead['presupuesto']
  }
  new_status: Lead['status']
  confirm?: boolean
}, supabase: Supabase): Promise<ToolResult> {
  const { filter, new_status, confirm } = input
  if (!STATUS_LIST.includes(new_status)) {
    return { ok: false, summary: `Status inválido: ${new_status}`, error: 'invalid_status' }
  }

  // Query con filtros
  let q = supabase.from('leads').select('id, email, nombre, status, status_changed_at, canal_adquisicion, presupuesto')
  if (filter.current_status) q = q.eq('status', filter.current_status)
  if (filter.canal) q = q.ilike('canal_adquisicion', `%${filter.canal}%`)
  if (filter.presupuesto) q = q.eq('presupuesto', filter.presupuesto)
  const { data: candidates, error } = await q.limit(500)
  if (error) return { ok: false, summary: error.message, error: error.message }

  // Filtrar por días en stage (en memoria, status_changed_at)
  const now = Date.now()
  const DAY = 86400_000
  const filtered = (candidates || []).filter(l => {
    if (filter.min_days_in_stage == null && filter.max_days_in_stage == null) return true
    const t = l.status_changed_at ? new Date(l.status_changed_at).getTime() : 0
    const days = (now - t) / DAY
    if (filter.min_days_in_stage != null && days < filter.min_days_in_stage) return false
    if (filter.max_days_in_stage != null && days > filter.max_days_in_stage) return false
    return true
  })

  if (filtered.length === 0) {
    return { ok: true, summary: `Ningún lead matchea el filtro`, affected: [] }
  }

  // Dry-run por default
  if (!confirm) {
    return {
      ok: true,
      summary: `[DRY-RUN] ${filtered.length} leads matchean el filtro. Llamá de nuevo con confirm=true para aplicar.`,
      affected: filtered.slice(0, 20).map(l => ({ id: l.id, email: l.email, nombre: l.nombre })),
      data: { total_matched: filtered.length, sample_shown: Math.min(filtered.length, 20) },
    }
  }

  // Aplicar
  const ids = filtered.map(l => l.id)
  const { error: upErr } = await supabase.from('leads').update({ status: new_status }).in('id', ids)
  if (upErr) return { ok: false, summary: upErr.message, error: upErr.message }

  // Log en lead_actividad
  const activs = filtered.map(l => ({
    lead_id: l.id,
    tipo: 'status_change',
    descripcion: `Status cambiado a: ${new_status}`,
    metadata: { source: 'asistente_ai_bulk', from: l.status, to: new_status },
  }))
  await supabase.from('lead_actividad').insert(activs)

  return {
    ok: true,
    summary: `${filtered.length} leads actualizados a ${new_status}`,
    affected: filtered.slice(0, 20).map(l => ({ id: l.id, email: l.email, nombre: l.nombre })),
    data: { total_updated: filtered.length },
  }
}

async function execAddNote(input: { lead_email: string; note: string; mode?: 'append' | 'overwrite' }, supabase: Supabase): Promise<ToolResult> {
  const { lead_email, note, mode = 'append' } = input
  const { data: lead } = await supabase
    .from('leads').select('id, email, nombre, notas')
    .ilike('email', lead_email).single()
  if (!lead) return { ok: false, summary: `No se encontró lead con email ${lead_email}`, error: 'not_found' }

  const stamp = new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
  const newNote = mode === 'overwrite' || !lead.notas
    ? note
    : `${lead.notas}\n[${stamp}] ${note}`

  const { error } = await supabase.from('leads').update({ notas: newNote }).eq('id', lead.id)
  if (error) return { ok: false, summary: error.message, error: error.message }

  await supabase.from('lead_actividad').insert({
    lead_id: lead.id,
    tipo: 'field_change',
    descripcion: mode === 'overwrite' ? 'Nota sobrescrita' : 'Nota agregada',
    metadata: { source: 'asistente_ai', note },
  })

  return {
    ok: true,
    summary: `Nota ${mode === 'overwrite' ? 'sobrescrita' : 'agregada'} en ${lead.nombre || lead.email}`,
    affected: [{ id: lead.id, email: lead.email, nombre: lead.nombre }],
  }
}

async function execQueueVambeCalls(input: { lead_emails: string[]; prompt?: string }, _supabase: Supabase): Promise<ToolResult> {
  return {
    ok: true,
    summary: `[PLACEHOLDER] Vambe aún no está conectado. Cuando se conecte, encolaría ${input.lead_emails.length} llamadas con el prompt: "${input.prompt || '(default)'}"`,
    data: { queued: input.lead_emails, prompt: input.prompt },
  }
}

async function findLeadByEmail(supabase: Supabase, email: string): Promise<Lead | null> {
  const { data } = await supabase.from('leads').select('*').ilike('email', email).maybeSingle()
  return (data as Lead | null) ?? null
}

async function execSendVambeTemplate(input: { lead_email: string; template_id: string; variables?: Record<string, unknown> }, supabase: Supabase): Promise<ToolResult> {
  const lead = await findLeadByEmail(supabase, input.lead_email)
  if (!lead) return { ok: false, summary: `Lead ${input.lead_email} no encontrado`, error: 'not_found' }
  if (!lead.telefono) return { ok: false, summary: `Lead ${input.lead_email} no tiene teléfono`, error: 'no_phone' }
  try {
    await sendTemplate({ phone: lead.telefono, templateId: input.template_id, data: input.variables || {} })
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'vambe_template_sent',
      descripcion: `Template ${input.template_id.slice(0, 8)}… enviado vía Vambe`,
      metadata: { source: 'asistente_ai', template_id: input.template_id, variables: input.variables },
    })
    return {
      ok: true,
      summary: `Template enviado a ${lead.nombre || lead.email} por WhatsApp`,
      affected: [{ id: lead.id, email: lead.email, nombre: lead.nombre }],
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, summary: `Falló envío de template: ${msg}`, error: msg }
  }
}

async function execSendVambeMessage(input: { lead_email: string; message: string }, supabase: Supabase): Promise<ToolResult> {
  const lead = await findLeadByEmail(supabase, input.lead_email)
  if (!lead) return { ok: false, summary: `Lead ${input.lead_email} no encontrado`, error: 'not_found' }
  if (!lead.telefono) return { ok: false, summary: `Lead ${input.lead_email} no tiene teléfono`, error: 'no_phone' }
  try {
    await sendMessage({ phone: lead.telefono, message: input.message })
    await supabase.from('lead_actividad').insert({
      lead_id: lead.id,
      tipo: 'vambe_message_sent',
      descripcion: `📤 Vambe (asistente): ${input.message.slice(0, 100)}`,
      metadata: { source: 'asistente_ai', message: input.message },
    })
    return {
      ok: true,
      summary: `Mensaje enviado a ${lead.nombre || lead.email}`,
      affected: [{ id: lead.id, email: lead.email, nombre: lead.nombre }],
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, summary: `Falló envío: ${msg}`, error: msg }
  }
}

async function execStartVambeConversation(input: { lead_emails: string[]; send_welcome?: boolean }, supabase: Supabase): Promise<ToolResult> {
  const sendWelcome = input.send_welcome !== false  // default true
  const affected: Array<{ id: string; email: string; nombre: string | null }> = []
  const errors: string[] = []
  for (const email of input.lead_emails) {
    const lead = await findLeadByEmail(supabase, email)
    if (!lead) { errors.push(`${email}: no encontrado`); continue }
    const sync = await syncLeadToVambe(lead, { sendWelcome })
    if (sync.ok) {
      if (sync.ai_contact_id) {
        await supabase.from('leads').update({ vambe_contact_id: sync.ai_contact_id }).eq('id', lead.id)
      }
      affected.push({ id: lead.id, email: lead.email, nombre: lead.nombre })
      await supabase.from('lead_actividad').insert({
        lead_id: lead.id,
        tipo: 'vambe_sync',
        descripcion: `Conversación iniciada en Vambe${sync.welcome_sent ? ' (welcome enviado)' : ''}`,
        metadata: { source: 'asistente_ai', ...sync },
      })
    } else {
      errors.push(`${email}: ${sync.error}`)
    }
  }
  return {
    ok: errors.length === 0,
    summary: `${affected.length} conversaciones iniciadas en Vambe${errors.length ? ` · ${errors.length} fallaron` : ''}`,
    affected,
    data: { errors, sendWelcome },
  }
}

async function execGenerateFile(input: {
  filename: string
  mime_type: string
  content: string
  description?: string
}, _supabase: Supabase): Promise<ToolResult> {
  // Sanitize filename — sin paths, solo nombre + extensión
  const safeFilename = input.filename.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 100)
  const bytes = new TextEncoder().encode(input.content).length
  return {
    ok: true,
    summary: input.description || `Archivo ${safeFilename} listo para descargar (${(bytes / 1024).toFixed(1)} KB)`,
    data: {
      file: true,
      filename: safeFilename,
      mime_type: input.mime_type,
      content: input.content,
      size_bytes: bytes,
    },
  }
}

// ─── Router ─────────────────────────────────────────────────────────────
export async function executeTool(name: string, input: unknown, supabase: Supabase): Promise<ToolResult> {
  try {
    switch (name) {
      case 'update_lead_status':  return await execUpdateLeadStatus(input as Parameters<typeof execUpdateLeadStatus>[0], supabase)
      case 'bulk_update_status':  return await execBulkUpdateStatus(input as Parameters<typeof execBulkUpdateStatus>[0], supabase)
      case 'add_note_to_lead':    return await execAddNote(input as Parameters<typeof execAddNote>[0], supabase)
      case 'queue_vambe_calls':       return await execQueueVambeCalls(input as Parameters<typeof execQueueVambeCalls>[0], supabase)
      case 'send_vambe_template':     return await execSendVambeTemplate(input as Parameters<typeof execSendVambeTemplate>[0], supabase)
      case 'send_vambe_message':      return await execSendVambeMessage(input as Parameters<typeof execSendVambeMessage>[0], supabase)
      case 'start_vambe_conversation':return await execStartVambeConversation(input as Parameters<typeof execStartVambeConversation>[0], supabase)
      case 'generate_file':           return await execGenerateFile(input as Parameters<typeof execGenerateFile>[0], supabase)
      case 'send_template_campaign':  return await execSendTemplateCampaign(input as Parameters<typeof execSendTemplateCampaign>[0], supabase)
      case 'query_campaigns':         return await execQueryCampaigns(input as Parameters<typeof execQueryCampaigns>[0], supabase)
      case 'list_leads_filtered':     return await execListLeadsFiltered(input as Parameters<typeof execListLeadsFiltered>[0], supabase)
      default:                    return { ok: false, summary: `Tool desconocida: ${name}`, error: 'unknown_tool' }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, summary: `Error ejecutando ${name}: ${msg}`, error: msg }
  }
}

// ─── send_template_campaign ────────────────────────────────────────────
type SendTemplateCampaignInput = {
  template_id: string
  template_name?: string
  segment?: {
    status?: Lead['status'][]
    canal?: string[]
    vacante_contains?: string
    min_dias_sin_contactar?: number
    max_dias_sin_contactar?: number
  }
  override_vars?: Record<string, string>
  dry_run?: boolean
}

async function execSendTemplateCampaign(input: SendTemplateCampaignInput, supabase: Supabase): Promise<ToolResult> {
  if (!input.template_id) return { ok: false, summary: 'falta template_id', error: 'missing_template_id' }
  const dryRun = input.dry_run !== false

  // Resolver leads matcheantes
  let q = supabase.from('leads').select('*')
  if (input.segment?.status?.length) q = q.in('status', input.segment.status)
  if (input.segment?.canal?.length) q = q.in('canal_adquisicion', input.segment.canal)
  if (input.segment?.vacante_contains) q = q.ilike('vacante', `%${input.segment.vacante_contains}%`)
  const { data: leads } = await q
  let filtered = (leads || []) as Lead[]

  if (input.segment?.min_dias_sin_contactar != null || input.segment?.max_dias_sin_contactar != null) {
    const now = Date.now()
    filtered = filtered.filter(l => {
      const ref = l.ultimo_contacto || l.status_changed_at || l.created_at
      if (!ref) return false
      const days = (now - new Date(ref).getTime()) / 86400000
      if (input.segment?.min_dias_sin_contactar != null && days < input.segment.min_dias_sin_contactar) return false
      if (input.segment?.max_dias_sin_contactar != null && days > input.segment.max_dias_sin_contactar) return false
      return true
    })
  }

  const sendable = filtered.filter(l => !!l.telefono)

  if (dryRun) {
    return {
      ok: true,
      summary: `🔍 DRY-RUN: ${sendable.length} leads recibirían el template (${filtered.length - sendable.length} sin teléfono saltados). Para mandarlo de verdad, llamala otra vez con dry_run=false.`,
      affected: sendable.slice(0, 20).map(l => ({ id: l.id, email: l.email, nombre: l.nombre })),
      data: { sendable_count: sendable.length, skipped: filtered.length - sendable.length },
    }
  }

  // Real send: delegate al endpoint /api/templates/send para reusar toda la lógica
  // (campaign tracking, auto-status, actividad, etc.)
  const baseUrl = process.env.NEXT_PUBLIC_CRM_URL || 'https://crm-alarcon-production.up.railway.app'
  const secret = process.env.VAMBE_WEBHOOK_SECRET || ''
  try {
    const res = await fetch(`${baseUrl}/api/templates/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify({
        templateId: input.template_id,
        templateName: input.template_name,
        leadIds: sendable.map(l => l.id),
        overrideVars: input.override_vars,
      }),
    })
    const data = await res.json()
    if (data.error) return { ok: false, summary: `Error: ${data.error}`, error: data.error }
    return {
      ok: true,
      summary: `✅ Campaña enviada — ${data.sent} leads contactados. Campaign ID: ${data.campaign_id || '(sin tracking)'}`,
      affected: sendable.slice(0, 20).map(l => ({ id: l.id, email: l.email, nombre: l.nombre })),
      data,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, summary: `Falla disparando campaña: ${msg}`, error: msg }
  }
}

// ─── query_campaigns ────────────────────────────────────────────────────
type QueryCampaignsInput = { limit?: number }

async function execQueryCampaigns(input: QueryCampaignsInput, supabase: Supabase): Promise<ToolResult> {
  const limit = Math.min(20, Math.max(1, input.limit || 10))
  const { data: campaigns, error } = await supabase
    .from('vambe_campaigns')
    .select('id, template_name, template_id, total_sent, total_failed, source, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    return { ok: false, summary: `No pude leer campaigns: ${error.message}`, error: error.message }
  }
  const rows = campaigns || []
  if (rows.length === 0) {
    return { ok: true, summary: 'No hay campañas registradas todavía.', data: { campaigns: [] } }
  }

  // Outcomes
  const ids = rows.map(c => c.id)
  const { data: outcomes } = await supabase
    .from('vambe_campaign_recipients')
    .select('campaign_id, sent_at, responded_at, scheduled_call_at, paid_at')
    .in('campaign_id', ids)
  const m: Record<string, { sent: number; responded: number; scheduled: number; paid: number }> = {}
  for (const id of ids) m[id] = { sent: 0, responded: 0, scheduled: 0, paid: 0 }
  for (const r of outcomes || []) {
    const id = r.campaign_id as string
    if (r.sent_at) m[id].sent++
    if (r.responded_at) m[id].responded++
    if (r.scheduled_call_at) m[id].scheduled++
    if (r.paid_at) m[id].paid++
  }
  const enriched = rows.map(c => ({ ...c, metrics: m[c.id] }))
  return {
    ok: true,
    summary: `${rows.length} campaña${rows.length === 1 ? '' : 's'} encontrada${rows.length === 1 ? '' : 's'}.`,
    data: { campaigns: enriched },
  }
}

// ─── list_leads_filtered ────────────────────────────────────────────────
// Lazy import del scoring para evitar circulars
type ListLeadsFilteredInput = {
  score_bucket?: 'hot' | 'warm' | 'cold' | 'any'
  status?: Lead['status'] | 'any'
  canal?: string
  created_within_days?: number
  min_days_in_stage?: number
  max_days_in_stage?: number
  limit?: number
}

async function execListLeadsFiltered(input: ListLeadsFilteredInput, supabase: Supabase): Promise<ToolResult> {
  const { leadScore, scoreBucket } = await import('./scoring')
  const lim = Math.min(input.limit || 20, 30)
  let query = supabase.from('leads').select('*')
  if (input.status && input.status !== 'any') query = query.eq('status', input.status)
  if (input.canal) query = query.ilike('canal_adquisicion', `%${input.canal}%`)
  if (input.created_within_days) {
    const since = new Date(Date.now() - input.created_within_days * 86400_000).toISOString()
    query = query.gte('created_at', since)
  }
  const { data, error } = await query.limit(500)
  if (error) return { ok: false, summary: `Error: ${error.message}`, error: error.message }
  let rows = (data || []) as Lead[]

  // Filtros que no se pueden hacer en SQL directo
  if (input.score_bucket && input.score_bucket !== 'any') {
    rows = rows.filter(l => scoreBucket(leadScore(l)) === input.score_bucket)
  }
  if (input.min_days_in_stage !== undefined || input.max_days_in_stage !== undefined) {
    rows = rows.filter(l => {
      const since = l.status_changed_at ? new Date(l.status_changed_at).getTime() : new Date(l.created_at).getTime()
      const days = (Date.now() - since) / 86400_000
      if (input.min_days_in_stage !== undefined && days < input.min_days_in_stage) return false
      if (input.max_days_in_stage !== undefined && days > input.max_days_in_stage) return false
      return true
    })
  }

  // Orden: score desc, después created desc
  rows.sort((a, b) => {
    const sa = leadScore(a)
    const sb = leadScore(b)
    if (sa !== sb) return sb - sa
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  const top = rows.slice(0, lim).map(l => {
    const score = leadScore(l)
    const since = l.status_changed_at ? new Date(l.status_changed_at).getTime() : new Date(l.created_at).getTime()
    const daysInStage = Math.round((Date.now() - since) / 86400_000)
    const daysSinceCreated = Math.round((Date.now() - new Date(l.created_at).getTime()) / 86400_000)
    return {
      id: l.id,
      nombre: l.nombre,
      empresa: l.empresa,
      email: l.email,
      telefono: l.telefono,
      vacante: l.vacante,
      presupuesto: l.presupuesto,
      status: l.status,
      canal: l.canal_adquisicion,
      score,
      bucket: scoreBucket(score),
      days_in_stage: daysInStage,
      days_since_created: daysSinceCreated,
    }
  })
  return {
    ok: true,
    summary: `${rows.length} leads matchean los filtros; mostrando los ${top.length} de mayor score.`,
    data: { leads: top, total_matching: rows.length, filters_applied: input },
  }
}
