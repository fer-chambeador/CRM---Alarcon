import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { phoneToState } from '@/lib/lada'
import { TOOL_DEFINITIONS, executeTool, type ToolResult } from '@/lib/aiTools'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
// Sonnet 4.6: rate limit MUCHO más alto que Haiku (Tier estándar: 50K vs 10K tokens/min)
// + razonamiento superior para análisis cualitativo de patrones. El system prompt está
// con prompt caching → costo neto se mantiene bajo aunque el modelo sea más caro.
const MODEL = 'claude-sonnet-4-6'

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
  const countBy = <K extends keyof LeadLite>(rows: LeadLite[], key: K, defaultLabel = '(sin valor)') => {
    const m: Record<string, number> = {}
    for (const l of rows) {
      const k = (l[key] as string) || defaultLabel
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

  // Counts por mes (últimos 6 meses) — para preguntas "cuántos leads en X mes"
  const byMonth: Record<string, number> = {}
  for (const l of leads) {
    const ym = (l.created_at || '').slice(0, 7) // YYYY-MM
    if (ym) byMonth[ym] = (byMonth[ym] || 0) + 1
  }
  const recentMonths = Object.entries(byMonth)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 6)
    .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {} as Record<string, number>)

  return {
    total_leads_in_db: leads.length,
    by_status: countBy(leads, 'status'),
    by_canal_global: countBy(leads, 'canal_adquisicion', '(sin canal)'),
    by_month_last6: recentMonths,
    today:      { count: today.length,     by_canal: countBy(today, 'canal_adquisicion', '(sin canal)') },
    this_week:  { count: thisWeek.length,  by_canal: countBy(thisWeek, 'canal_adquisicion', '(sin canal)') },
    this_month: { count: thisMonth.length, by_canal: countBy(thisMonth, 'canal_adquisicion', '(sin canal)'), by_status: countBy(thisMonth, 'status') },
    last_month: { count: lastMonth.length, by_canal: countBy(lastMonth, 'canal_adquisicion', '(sin canal)'), by_status: countBy(lastMonth, 'status') },
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

CÓMO USAR EL CONTEXTO:
- Te paso un SUMMARY pre-calculado con counts globales (by_status, by_canal_global, by_month_last6) y
  por periodos (today, this_week, this_month, last_month). USÁ ESTOS NÚMEROS — no los recalcules.
- NO te paso la lista completa de leads (son demasiados, excede el rate limit). Si el user pide DETALLES
  de leads específicos (nombres, emails, etc.), usá la tool \`list_leads_filtered\` para traerlos.

ESQUEMA DE LEADS:
- email, nombre, empresa, telefono
- puesto = decision maker (rol del contacto en su empresa)
- vacante = el rol que ESE cliente quiere reclutar
- canal_adquisicion (Instagram, TikTok, Facebook, Inbound, Google, Recomendación, Canirac, etc.)
- status: nuevo | contactado | llamada_agendada | no_show_llamada | presentacion_enviada | espera_aprobacion | convertido | cliente_recurrente | descartado
- monto (MXN, default 1160)
- presupuesto: none / 100_to_1000 / 2000_to_5000 / 10000_plus / null
- created_at, status_changed_at (ISO)
- veces_contactado (0..4)

CUÁNDO USAR TOOLS:
- "actualiza/cambia X a Y" → update_lead_status o bulk_update_status
- "agregá nota a X" → add_note_to_lead
- "muéstrame leads X / dame los leads que..." → list_leads_filtered (devuelve hasta 30 leads con detalle)
- Acciones masivas: SIEMPRE primero con confirm=false (dry-run) para mostrar al user qué se va a cambiar,
  y solo aplicá confirm=true después de que el user confirme.
- "dame CSV", "exporta a archivo", "descárgame X", "pasame en archivo" → SIEMPRE usá generate_file
  EN EL MISMO TURNO. No digas "voy a generar..." sin llamar la tool — eso no produce nada.
  Para CSVs grandes: primero usá list_leads_filtered para traer los leads relevantes, luego generate_file
  con el contenido. NO listes el CSV inline.

CUÁNDO NO USAR TOOLS:
- Preguntas de análisis con counts ("cuántos", "qué canal tiene más", "porcentaje conversión") →
  respondé DIRECTO desde el SUMMARY. No llames tools innecesarias.

ESTILO DE RESPUESTA:
- Conciso, español de México.
- Números concretos: counts, montos en MXN ($ con comas), %.
- Markdown ok. Tablas markdown si ayudan.
- Al ejecutar acciones, confirmá qué se hizo y cuántos leads se afectaron.

═══════════════════════════════════════════════════════════════════════
CONOCIMIENTO DEL PRODUCTO — para reportes y respuestas con contexto real:

CHAMBAS AY (qué vende):
- Bolsa de trabajo en WhatsApp enfocada SOLO en operativos (meseros, choferes,
  ayudantes generales, call center, almacenistas, lavalozas, cocineros, etc.).
- Cobramos por "espacio de publicación": $1,160 MXN, dura 30 días, editable
  ilimitadamente. Una publicación = una vacante activa.
- Buscamos candidatos por código postal cerca del cliente, filtramos por
  preguntas que el cliente define, los mandamos a entrevista por WhatsApp.
- Pago: liga de pago (tarjeta) o transferencia. Rodrigo del equipo apoya
  con facturación.

DAPTA — Daniela (agente de voz IA):
- Llama por teléfono a los leads "Llamada agendada" para cerrar la venta de
  $1,160. Modelo Gemini 3.1 Pro, tono mexicano cálido.
- Origen del número: +525517282187 (fijo).
- Flow: Daniela explica producto en 4-6 min, cierra con "te mando la liga
  de pago" o "te mando la presentación" según interés.
- Outcomes que Daniela detecta (campo \`outcome\` en llamadas):
  * pidio_link_pago → cliente quiere pagar YA. Daniela cierra "te llega la liga".
    Auto-mueve el lead a status 'liga_pago_enviada'.
  * pidio_presentacion → cliente quiere material para pasar a dirección.
    Auto-mueve a 'presentacion_enviada' + crea aprobación de propuesta.
  * callback → cliente pide volver a hablar otro día.
  * no_interesado → descarte.
  * no_answer / voicemail → no contestó.
- Campos clave: \`interes_real\` (alto/medio/bajo), \`sentimiento\` (positivo/neutral/negativo),
  \`duration_seconds\` (≥180s = llamada exitosa real, <180s = enganche corto).
- Tabla: \`llamadas\` con \`lead_id\`, \`dapta_call_id\`, \`status\`, \`outcome\`, \`transcript\`,
  \`custom_analysis\`, \`pidio_link_pago\`, \`pidio_presentacion\`, \`agendar_seguimiento\`.
- Llamada "exitosa" = duration_seconds ≥ 180 + status='completed'.

VAMBE — WhatsApp AI:
- 4 asistentes: Outbound (cold leads), Interesado Agendador (warm), Agendados
  Consultoría (post-llamada agendada → confirma o reagenda — TAMBIÉN cubre
  stage Confirmados ✅), Agendador llamadas y videollamadas (deprecated,
  solo llamada 10 min).
- Pipeline Vambe (etapas): Lanzamiento → Interesado → Agendados Consultoría 📆
  → Llamadas ☎️ → Asistencia Humana → Contactados via WhatsApp → Confirmados ✅
  → Ganados → Perdidos.
- Templates Meta aprobados: outbound_primer_mensaje_sales (cold opener),
  meeting_reminder_in_person_default_template (reminder 20 min antes),
  outbound_v1/v2/enero_2026 (variantes outbound), te_extranamos (reactivación),
  tom (form), probando_crm (test). Templates requieren aprobación Meta para
  editarse (minutos a 24h).
- Outbound flow: lead nuevo → CRM lo crea desde Slack/form → /outbound genera
  aprobación con score → Fer aprueba o rechaza → si aprueba se manda template
  vía Vambe → contador veces_contactado +1, ultimo_contacto = NOW.
- Cuando Vambe envía mensaje fuera del CRM (bot proactivo o humano del equipo
  desde la UI de Vambe), el webhook message.sent llega al CRM y bumpea
  veces_contactado igualmente (con guard de 5 min para evitar double-bump
  con quick-action).

EMBUDO DE VENTAS (status interno del CRM):
- nuevo → contactado → llamada_agendada → llamada_con_dapta → presentacion_enviada
  → espera_aprobacion → liga_pago_enviada → convertido → cliente_recurrente
- descartado: lead muerto. Marcado con razón en notas (Audit #4).
- Recurrente: pagó al menos 2 veces. cliente_recurrente es subset de convertido
  para el funnel.

CRON / AUTOMATIZACIÓN ACTIVA:
- Cron 'promote-recurrentes' día 1 cada mes: convertidos del mes anterior →
  cliente_recurrente.
- Cron 'cron-trigger-scheduled' c/15min: dispara llamadas Dapta que tienen
  scheduled_at en próximos 5 min.
- Webhook Vambe → CRM: registra mensajes, cambia status según stage de Vambe,
  silencia SOS si lead viene de flujo confirmado (Vambe 6).
- Webhook Dapta post-call: post-llamada actualiza status + crea actividades +
  dispara follow-up GCal.

KPIs OPERATIVOS CLAVE (para análisis):
- Tasa conversión global: convertidos / (total - descartados).
- Tasa Dapta exitosa → pagó: dapta_convertidas / dapta_exitosa_leads.
- Tasa Outbound → respondió: outbound_pidio_llamada / outbound_total_leads.
- Llamadas manuales: agendadas - dapta_disparadas (cuánto trabajo manual hizo Fer).
- Pipeline cerrado: suma de monto de leads convertidos (default $1,160 por lead).
═══════════════════════════════════════════════════════════════════════

CUÁNDO USAR generate_analytics_report:
- "dame un reporte", "análisis del mes", "qué patrones ves", "cómo va la operación"
- Después de llamarla, el resultado incluye datos pre-calculados + instrucciones
  para redactar el reporte. Tú redactas el markdown final con análisis y patrones,
  y LLAMAS \`generate_file\` con filename "reporte-YYYY-MM-DD.md" para que el user
  lo descargue.
- El frontend convierte el markdown a PDF automáticamente en el navegador (jsPDF).
  El user ve botón "⇣ Descargar PDF" — recibe el PDF directo, no markdown.
`

const MAX_TURNS = 10  // subido de 5 → más espacio para flows multi-tool (analítica + reporte + tool de envío)

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Falta ANTHROPIC_API_KEY en Railway.' }, { status: 500 })
  }
  const body = await req.json().catch(() => null)
  const question: string = (body?.question || '').toString().trim()
  if (!question) return NextResponse.json({ error: 'Pregunta vacía' }, { status: 400 })

  // Memoria entre conversaciones: el cliente puede pasar `history` con turnos
  // anteriores (role+content). El backend los antepone a la nueva pregunta
  // para que el asistente recuerde follow-ups ("de esos, cuántos respondieron?").
  // Cap a últimos 6 turnos para no estallar tokens.
  type HistoryTurn = { role: 'user' | 'assistant'; content: string }
  const rawHistory = Array.isArray(body?.history) ? body.history as HistoryTurn[] : []
  const history = rawHistory
    .filter(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
    .slice(-6)

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

  // ESTRATEGIA DE TOKENS (fix Phase 104):
  // Antes mandábamos los 555 leads en cada request → ~59K input tokens, excede
  // el rate limit Haiku de 10K tokens/min. Ahora mandamos SOLO el SUMMARY
  // pre-calculado (~1K tokens) y si el modelo necesita leads específicos,
  // los pide vía `list_leads_filtered` tool. Reduce 95% el costo y elimina 429.
  const userMsg = `SUMMARY pre-calculado de la base (usá ESTOS números para counts; NO recalcules):
\`\`\`json
${JSON.stringify(summary, null, 2)}
\`\`\`

Total leads en DB: ${enriched.length}

Si necesitás detalles de leads específicos (nombres, emails, teléfonos), usá la tool \`list_leads_filtered\`.

Pregunta del user:
${question}`

  // Loop de tool use con memoria de conversación
  type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }
  const messages: AnthropicMessage[] = []
  // Inyectar historia previa como contexto (sin el dump de LEADS — eso solo en el turno actual)
  for (const t of history) {
    messages.push({ role: t.role, content: t.content })
  }
  messages.push({ role: 'user', content: userMsg })
  const actionsApplied: Array<{ tool: string; input: unknown; result: ToolResult }> = []
  let finalAnswer = ''
  let totalUsage = { input_tokens: 0, output_tokens: 0 }

  // Helper: fetch con retry exponencial en 429 (rate limit). Anthropic sugiere
  // mirar retry-after header pero por simplicidad esperamos 2s/5s/10s.
  async function anthropicCall(payload: unknown): Promise<Response> {
    const delays = [2000, 5000, 10000]
    let lastRes: Response | null = null
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const r = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey!,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify(payload),
      })
      if (r.status !== 429 && r.status !== 529) return r
      lastRes = r
      // Respetar retry-after del server si viene
      const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10)
      const wait = retryAfter > 0 ? retryAfter * 1000 : (delays[attempt] || 10000)
      console.warn(`[ai/query] Anthropic ${r.status} — retry ${attempt + 1} in ${wait}ms`)
      await new Promise(resolve => setTimeout(resolve, wait))
    }
    return lastRes!
  }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // System prompt cacheado — Anthropic cobra menos por tokens cached (90% off
    // después del primer hit). El system es estable entre requests del mismo día.
    const systemBlocks = [
      { type: 'text', text: SYSTEM(ctx), cache_control: { type: 'ephemeral' } },
    ]
    const res = await anthropicCall({
      model: MODEL,
      max_tokens: 16000,  // Sonnet 4.6 admite outputs grandes (reportes analytics, CSVs masivos)
      system: systemBlocks,
      messages,
      tools: TOOL_DEFINITIONS,
    })
    if (!res.ok) {
      const text = await res.text()
      // Mensaje amigable para 429
      if (res.status === 429) {
        return NextResponse.json({
          error: `Anthropic rate limit excedido después de varios retries. Esperá un minuto e intentá de nuevo.`,
        }, { status: 429 })
      }
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
