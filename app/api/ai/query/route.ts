import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { phoneToState } from '@/lib/lada'
import { TOOL_DEFINITIONS, executeTool, type ToolResult } from '@/lib/aiTools'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'  // Haiku: rápido + barato y soporta tool use bien

/**
 * Pre-calcula bounds de fecha para que el modelo NO los infiera mal.
 * El bug clásico era que "este mes" se interpretaba como "hoy".
 */
function buildDateContext() {
  const now = new Date()
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const endOfMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)
  // Semana lunes a domingo
  const day = now.getDay()
  const diffToMonday = day === 0 ? -6 : 1 - day
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() + diffToMonday); startOfWeek.setHours(0, 0, 0, 0)
  return {
    today: fmt(now),
    this_week_start: fmt(startOfWeek),
    this_month_start: fmt(startOfMonth),
    this_month_end:   fmt(endOfMonth),
    last_month_start: fmt(startOfLastMonth),
    last_month_end:   fmt(endOfLastMonth),
    today_ms: startOfDay(now).getTime(),
    week_ms:  startOfWeek.getTime(),
    month_ms: startOfMonth.getTime(),
    last_month_start_ms: startOfLastMonth.getTime(),
    last_month_end_ms:   endOfLastMonth.getTime(),
  }
}

/**
 * Pre-calcula contadores para evitar que el modelo se equivoque al
 * agregar manualmente. El asistente tiene los números listos.
 */
type LeadLite = {
  email: string; nombre: string | null; empresa: string | null; telefono: string | null
  puesto: string | null; vacante: string | null; canal_adquisicion: string | null
  status: string; monto: number; veces_contactado: number
  created_at: string; status_changed_at: string
  estado: string | null; presupuesto: string | null
}

function buildSummary(leads: LeadLite[], ctx: ReturnType<typeof buildDateContext>) {
  const countByCanal = (rows: LeadLite[]) => {
    const m: Record<string, number> = {}
    for (const l of rows) {
      const k = l.canal_adquisicion || '(sin canal)'
      m[k] = (m[k] || 0) + 1
    }
    return m
  }
  const inRange = (start: number, end: number | null = null) => leads.filter(l => {
    const t = new Date(l.created_at).getTime()
    return t >= start && (end == null || t <= end)
  })
  const today      = inRange(ctx.today_ms)
  const thisWeek   = inRange(ctx.week_ms)
  const thisMonth  = inRange(ctx.month_ms)
  const lastMonth  = inRange(ctx.last_month_start_ms, ctx.last_month_end_ms)
  const cerrados   = leads.filter(l => l.status === 'convertido' || l.status === 'cliente_recurrente')
  return {
    total_leads_in_db: leads.length,
    today:      { count: today.length,     by_canal: countByCanal(today) },
    this_week:  { count: thisWeek.length,  by_canal: countByCanal(thisWeek) },
    this_month: { count: thisMonth.length, by_canal: countByCanal(thisMonth) },
    last_month: { count: lastMonth.length, by_canal: countByCanal(lastMonth) },
    total_cerrados: cerrados.length,
    pipeline_cerrado_mxn: cerrados.reduce((s, l) => s + (l.monto || 0), 0),
  }
}

const SYSTEM = (ctx: ReturnType<typeof buildDateContext>) => `Sos el asistente del CRM de Chambas. El usuario es Fer, dueño del producto.

PODÉS HACER DOS COSAS:
1. RESPONDER preguntas sobre los leads (counts, conversiones, patrones).
2. EJECUTAR acciones sobre la base de datos usando las TOOLS disponibles.

FECHAS (USÁ ESTAS BOUNDS EXACTOS, NO INFIERAS):
- Hoy: ${ctx.today}
- Esta semana: desde ${ctx.this_week_start} (lunes) hasta hoy
- Este mes: desde ${ctx.this_month_start} hasta ${ctx.this_month_end} (mes calendario completo)
- Mes pasado: desde ${ctx.last_month_start} hasta ${ctx.last_month_end}

REGLA CRÍTICA: cuando el user diga "este mes" se refiere al MES CALENDARIO COMPLETO, no a "hoy".
Si pregunta "cuántos leads cayeron este mes", contestá con el count de TODO el mes, no del día.
Te paso un objeto SUMMARY pre-calculado con los counts de today/this_week/this_month/last_month
para que NO los re-calcules desde el JSON.

ESQUEMA DE LEADS:
- email, nombre, empresa, telefono
- puesto = decision maker (rol del contacto en su empresa)
- vacante = el rol que ESE cliente quiere reclutar
- canal_adquisicion (Instagram, TikTok, Facebook, Inbound, Google, Recomendación, etc.)
- status: nuevo | contactado | llamada_agendada | no_show_llamada | presentacion_enviada | espera_aprobacion | convertido | cliente_recurrente | descartado
- monto (MXN, default 1160)
- presupuesto: none / 100_to_1000 / 2000_to_5000 / 10000_plus / null
- created_at, status_changed_at (ISO)
- veces_contactado (0..4)

CUÁNDO USAR TOOLS:
- "actualiza/cambia X a Y" → usá update_lead_status o bulk_update_status
- "agregá nota a X" → add_note_to_lead
- Acciones masivas: SIEMPRE primero con confirm=false (dry-run) para mostrar al user qué se va a cambiar,
  y solo aplicá confirm=true después de que el user confirme.
- "llamá por AI a X" → queue_vambe_calls (placeholder, avisá que no está implementado todavía).

CUÁNDO NO USAR TOOLS:
- Preguntas de análisis ("cuántos", "qué canal", "promedio") → respondé directo desde el JSON/summary, sin tools.

ESTILO DE RESPUESTA:
- Conciso, español de México.
- Números concretos: counts, montos en MXN ($ con comas), %.
- Markdown ok. Tablas markdown si ayudan.
- Si la respuesta involucra >5 leads, agrupá.
- Al ejecutar acciones, confirmá qué se hizo y cuántos leads se afectaron.
`

const MAX_TURNS = 5

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Falta ANTHROPIC_API_KEY en Railway.' }, { status: 500 })
  }
  const body = await req.json().catch(() => null)
  const question: string = (body?.question || '').toString().trim()
  if (!question) return NextResponse.json({ error: 'Pregunta vacía' }, { status: 400 })

  const supabase = createServiceClient()
  const { data: leads, error } = await supabase
    .from('leads')
    .select('email,nombre,empresa,telefono,puesto,vacante,canal_adquisicion,status,monto,veces_contactado,created_at,status_changed_at,estado,presupuesto')
    .order('created_at', { ascending: false })
    .limit(2000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const enriched = (leads || []).map(l => ({ ...l, estado: l.estado || phoneToState(l.telefono) })) as LeadLite[]
  const ctx = buildDateContext()
  const summary = buildSummary(enriched, ctx)

  const userMsg = `SUMMARY pre-calculado (usá ESTOS números cuando preguntan por counts):
\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\`

LEADS completos (JSON, para queries específicos):
\`\`\`json
${JSON.stringify(enriched)}
\`\`\`

Pregunta del user:
${question}`

  // Loop de tool use
  type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }
  const messages: AnthropicMessage[] = [{ role: 'user', content: userMsg }]
  const actionsApplied: Array<{ tool: string; input: unknown; result: ToolResult }> = []
  let finalAnswer = ''
  let totalUsage = { input_tokens: 0, output_tokens: 0 }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM(ctx),
        messages,
        tools: TOOL_DEFINITIONS,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `API Anthropic ${res.status}: ${text.slice(0, 400)}` }, { status: 502 })
    }
    const data = await res.json()
    const usage = data?.usage || {}
    totalUsage.input_tokens += usage.input_tokens || 0
    totalUsage.output_tokens += usage.output_tokens || 0

    const content = data?.content || []
    const stopReason = data?.stop_reason

    // Extraer texto y tool_use blocks
    const textBlocks: string[] = []
    const toolUses: Array<{ id: string; name: string; input: unknown }> = []
    for (const block of content) {
      if (block.type === 'text') textBlocks.push(block.text)
      else if (block.type === 'tool_use') toolUses.push({ id: block.id, name: block.name, input: block.input })
    }
    if (textBlocks.length) finalAnswer = textBlocks.join('\n\n')

    // Si no llamó tools, terminamos
    if (stopReason !== 'tool_use' || toolUses.length === 0) break

    // Ejecutar tools y armar tool_result message
    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = []
    for (const tu of toolUses) {
      const result = await executeTool(tu.name, tu.input, supabase)
      actionsApplied.push({ tool: tu.name, input: tu.input, result })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      })
    }

    messages.push({ role: 'assistant', content })
    messages.push({ role: 'user', content: toolResults })
  }

  return NextResponse.json({
    answer: finalAnswer || '(respuesta vacía)',
    usage: totalUsage,
    actions: actionsApplied,
    leadsConsidered: enriched.length,
  })
}
