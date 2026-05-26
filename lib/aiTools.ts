import { createServiceClient } from './supabase'
import { STATUS_ORDER } from './status'
import type { Lead } from './supabase'

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
      case 'queue_vambe_calls':   return await execQueueVambeCalls(input as Parameters<typeof execQueueVambeCalls>[0], supabase)
      case 'generate_file':       return await execGenerateFile(input as Parameters<typeof execGenerateFile>[0], supabase)
      default:                    return { ok: false, summary: `Tool desconocida: ${name}`, error: 'unknown_tool' }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, summary: `Error ejecutando ${name}: ${msg}`, error: msg }
  }
}
