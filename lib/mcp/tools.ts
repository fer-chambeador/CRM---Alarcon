import { createServiceClient, type Lead } from '@/lib/supabase'
import {
  STATUS_ORDER, STATUS_LABELS, PIPELINE_CLOSED, PIPELINE_CLOSING,
  DEFAULT_MONTO, sumMonto, getLeadAlert, fmtMoney,
} from '@/lib/status'
import { phoneToState } from '@/lib/lada'
import { normalizeCanal } from '@/lib/canales'
import { leadScore, scoreBucket, leadScoreBreakdown } from '@/lib/scoring'
import { fmtPresupuesto } from '@/lib/budget'

const STATUS_ENUM = STATUS_ORDER as readonly string[]
const ALLOWED_UPDATE = new Set([
  'nombre','empresa','telefono','puesto','canal_adquisicion','status','notas',
  'veces_contactado','monto','estado','presupuesto','vacante','llamada_at',
])

function trimLead(l: Lead) {
  return {
    id: l.id,
    email: l.email,
    nombre: l.nombre,
    empresa: l.empresa,
    telefono: l.telefono,
    puesto: l.puesto,
    vacante: l.vacante,
    canal: l.canal_adquisicion,
    estado: l.estado || phoneToState(l.telefono),
    presupuesto: fmtPresupuesto(l.presupuesto),
    presupuesto_raw: l.presupuesto,
    monto: l.monto ?? DEFAULT_MONTO,
    status: l.status,
    status_label: STATUS_LABELS[l.status],
    veces_contactado: l.veces_contactado ?? 0,
    score: leadScore(l),
    score_bucket: scoreBucket(leadScore(l)),
    llamada_at: l.llamada_at,
    created_at: l.created_at,
    status_changed_at: l.status_changed_at,
    ultimo_contacto: l.ultimo_contacto,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool registry — schemas se envían al cliente AI via tools/list
// ────────────────────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: 'list_leads',
    description:
      'Lista leads del CRM de Chambas con filtros opcionales (status, canal, estado, score, fechas, vacante). Devuelve summary por lead: email, nombre, empresa, status, canal, estado, score, monto, presupuesto, vacante, fecha de creación.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUS_ENUM, description: 'Filtrar por status. Valores: ' + STATUS_ORDER.join(', ') },
        canal: { type: 'string', description: 'Filtrar por canal de adquisición (Instagram, TikTok, Facebook, Inbound, Recomendación, Google, LinkedIn, WhatsApp).' },
        estado: { type: 'string', description: 'Filtrar por estado mexicano (CDMX, Jalisco, etc.).' },
        score_min: { type: 'number', description: 'Score mínimo (0-100). Tip: 60+ = hot, 30+ = warm.' },
        score_bucket: { type: 'string', enum: ['hot','warm','cold'] },
        vacante_contains: { type: 'string', description: 'Texto que debe contener el campo vacante (puesto buscado).' },
        date_from: { type: 'string', description: 'created_at desde (ISO YYYY-MM-DD).' },
        date_to: { type: 'string', description: 'created_at hasta (ISO YYYY-MM-DD).' },
        limit: { type: 'number', default: 50, description: 'Máx 200.' },
      },
    },
  },
  {
    name: 'get_lead',
    description: 'Trae un lead por email o id (UUID) con TODA su info y los últimos eventos de actividad.',
    inputSchema: {
      type: 'object',
      required: ['identifier'],
      properties: { identifier: { type: 'string', description: 'Email o UUID.' } },
    },
  },
  {
    name: 'update_lead_status',
    description: 'Cambia el status de un lead. Genera entry en activity log.',
    inputSchema: {
      type: 'object',
      required: ['id', 'status'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: STATUS_ENUM },
      },
    },
  },
  {
    name: 'bump_contact',
    description: 'Marca un nuevo intento de contacto: incrementa veces_contactado y resetea ultimo_contacto. Resetea el timer de alerta de 72h hábiles.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
  {
    name: 'update_lead',
    description: 'Actualiza campos arbitrarios de un lead. Campos permitidos: nombre, empresa, telefono, puesto, canal_adquisicion, status, notas, veces_contactado, monto, estado, presupuesto (none|100_to_1000|2000_to_5000|10000_plus), vacante, llamada_at (ISO timestamp).',
    inputSchema: {
      type: 'object',
      required: ['id', 'updates'],
      properties: {
        id: { type: 'string' },
        updates: { type: 'object', additionalProperties: true },
      },
    },
  },
  {
    name: 'create_lead',
    description: 'Crea un lead manualmente. Email es requerido.',
    inputSchema: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string' },
        nombre: { type: 'string' },
        empresa: { type: 'string' },
        telefono: { type: 'string' },
        puesto: { type: 'string' },
        vacante: { type: 'string' },
        canal_adquisicion: { type: 'string' },
        estado: { type: 'string' },
        presupuesto: { type: 'string', enum: ['none', '100_to_1000', '2000_to_5000', '10000_plus'] },
        monto: { type: 'number' },
        notas: { type: 'string' },
      },
    },
  },
  {
    name: 'get_analytics',
    description: 'Devuelve métricas agregadas en un rango de fechas: pipeline total/en cierre/cerrado, count por status, conversion rate, breakdown por canal/estado/vacante/presupuesto.',
    inputSchema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'YYYY-MM-DD' },
        date_to: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
  },
  {
    name: 'get_pendientes',
    description: 'Lista todas las alertas activas agrupadas por tipo: urgentes (descartar por intentos), follow up (72h hábiles), llamadas pendientes de actualizar, propuestas esperando resultado. Incluye próximas llamadas en los próximos 7 días.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ask',
    description: 'Hace una pregunta en lenguaje natural sobre el CRM. Útil para queries complejas combinando varios filtros y agregaciones. Pasa la pregunta tal cual y devuelve un análisis en prosa.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: { question: { type: 'string' } },
    },
  },
] as const

// ────────────────────────────────────────────────────────────────────────────
// Helpers para responder en formato MCP (content[].text con JSON adentro)
// ────────────────────────────────────────────────────────────────────────────

function textResult(obj: unknown) {
  return {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
  }
}

function errorResult(msg: string) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ────────────────────────────────────────────────────────────────────────────

export async function callTool(name: string, args: Record<string, unknown>) {
  const supabase = createServiceClient()

  if (name === 'list_leads') {
    const limit = Math.min(Number(args.limit) || 50, 200)
    let q = supabase.from('leads').select('*').order('created_at', { ascending: false }).limit(limit * 2)
    if (typeof args.status === 'string') q = q.eq('status', args.status)
    if (typeof args.canal === 'string') q = q.eq('canal_adquisicion', args.canal)
    if (typeof args.date_from === 'string') q = q.gte('created_at', args.date_from)
    if (typeof args.date_to === 'string') q = q.lt('created_at', args.date_to)
    const { data, error } = await q
    if (error) return errorResult(error.message)
    let rows = (data || []).map(trimLead)
    if (typeof args.estado === 'string') {
      const e = (args.estado as string).toLowerCase()
      rows = rows.filter(r => (r.estado || '').toLowerCase().includes(e))
    }
    if (typeof args.score_min === 'number') rows = rows.filter(r => r.score >= (args.score_min as number))
    if (typeof args.score_bucket === 'string') rows = rows.filter(r => r.score_bucket === args.score_bucket)
    if (typeof args.vacante_contains === 'string') {
      const v = (args.vacante_contains as string).toLowerCase()
      rows = rows.filter(r => (r.vacante || '').toLowerCase().includes(v))
    }
    rows = rows.slice(0, limit)
    return textResult({ count: rows.length, leads: rows })
  }

  if (name === 'get_lead') {
    const id = String(args.identifier)
    const byId = id.includes('-') && id.length >= 32
    const { data, error } = byId
      ? await supabase.from('leads').select('*').eq('id', id).single()
      : await supabase.from('leads').select('*').eq('email', id.toLowerCase().trim()).maybeSingle()
    if (error) return errorResult(error.message)
    if (!data) return errorResult('Lead no encontrado.')
    const { data: actividad } = await supabase
      .from('lead_actividad').select('tipo,descripcion,created_at')
      .eq('lead_id', (data as Lead).id).order('created_at', { ascending: false }).limit(20)
    const lead = trimLead(data as Lead)
    return textResult({
      lead,
      score_breakdown: leadScoreBreakdown(data as Lead),
      alert: getLeadAlert(data as Lead),
      actividad: actividad || [],
    })
  }

  if (name === 'update_lead_status') {
    const id = String(args.id)
    const status = String(args.status)
    if (!STATUS_ENUM.includes(status)) return errorResult(`Status inválido. Válidos: ${STATUS_ENUM.join(', ')}`)
    const { data, error } = await supabase.from('leads').update({ status }).eq('id', id).select().single()
    if (error) return errorResult(error.message)
    await supabase.from('lead_actividad').insert({ lead_id: id, tipo: 'status_change', descripcion: `Status cambiado a: ${status} (via MCP)`, metadata: { source: 'mcp' } })
    return textResult({ ok: true, lead: trimLead(data as Lead) })
  }

  if (name === 'bump_contact') {
    const id = String(args.id)
    const { data: lead } = await supabase.from('leads').select('veces_contactado').eq('id', id).single()
    if (!lead) return errorResult('Lead no encontrado.')
    const newCount = ((lead as { veces_contactado: number }).veces_contactado || 0) + 1
    const { data, error } = await supabase.from('leads')
      .update({ veces_contactado: newCount, ultimo_contacto: new Date().toISOString() })
      .eq('id', id).select().single()
    if (error) return errorResult(error.message)
    return textResult({ ok: true, veces_contactado: newCount, lead: trimLead(data as Lead) })
  }

  if (name === 'update_lead') {
    const id = String(args.id)
    const rawUpdates = (args.updates as Record<string, unknown>) || {}
    const updates: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rawUpdates)) {
      if (ALLOWED_UPDATE.has(k)) updates[k] = v
    }
    if (!Object.keys(updates).length) return errorResult('Ningún campo válido. Permitidos: ' + Array.from(ALLOWED_UPDATE).join(', '))
    if ('canal_adquisicion' in updates) updates.canal_adquisicion = normalizeCanal(updates.canal_adquisicion as string | null | undefined)
    const { data, error } = await supabase.from('leads').update(updates).eq('id', id).select().single()
    if (error) return errorResult(error.message)
    return textResult({ ok: true, updated_fields: Object.keys(updates), lead: trimLead(data as Lead) })
  }

  if (name === 'create_lead') {
    const email = String(args.email || '').trim().toLowerCase()
    if (!email) return errorResult('email requerido')
    const insert = {
      email,
      nombre: args.nombre ?? null,
      empresa: args.empresa ?? null,
      telefono: args.telefono ?? null,
      puesto: args.puesto ?? null,
      vacante: args.vacante ?? null,
      canal_adquisicion: typeof args.canal_adquisicion === 'string' ? normalizeCanal(args.canal_adquisicion) : null,
      estado: args.estado ?? null,
      presupuesto: args.presupuesto ?? null,
      monto: typeof args.monto === 'number' ? args.monto : DEFAULT_MONTO,
      notas: args.notas ?? null,
      status: 'nuevo',
      tipo_evento: 'manual',
    }
    const { data, error } = await supabase.from('leads').insert(insert).select().single()
    if (error) return errorResult(error.message)
    return textResult({ ok: true, lead: trimLead(data as Lead) })
  }

  if (name === 'get_analytics') {
    let q = supabase.from('leads').select('*')
    if (typeof args.date_from === 'string') q = q.gte('created_at', args.date_from)
    if (typeof args.date_to === 'string') q = q.lt('created_at', args.date_to)
    const { data, error } = await q
    if (error) return errorResult(error.message)
    const leads = (data || []) as Lead[]
    const closed = leads.filter(l => PIPELINE_CLOSED.includes(l.status))
    const closing = leads.filter(l => PIPELINE_CLOSING.includes(l.status))

    const groupBy = <K extends string>(rows: Lead[], keyOf: (l: Lead) => K | null) => {
      const map = new Map<string, { leads: number; cerrados: number; pipeline: number; pipeline_cerrado: number }>()
      for (const l of rows) {
        const k = keyOf(l) || '— sin dato —'
        const e = map.get(k) || { leads: 0, cerrados: 0, pipeline: 0, pipeline_cerrado: 0 }
        e.leads += 1
        e.pipeline += l.monto ?? DEFAULT_MONTO
        if (PIPELINE_CLOSED.includes(l.status)) {
          e.cerrados += 1
          e.pipeline_cerrado += l.monto ?? DEFAULT_MONTO
        }
        map.set(k, e)
      }
      return Array.from(map.entries())
        .map(([k, v]) => ({ key: k, ...v, conversion: v.leads > 0 ? v.cerrados / v.leads : 0 }))
        .sort((a, b) => b.pipeline - a.pipeline)
    }

    const byStatus: Record<string, number> = {}
    for (const l of leads) byStatus[l.status] = (byStatus[l.status] || 0) + 1

    return textResult({
      total_leads: leads.length,
      pipeline_total: sumMonto(leads),
      pipeline_en_cierre: sumMonto(closing),
      pipeline_cerrado: sumMonto(closed),
      pipeline_cerrado_fmt: fmtMoney(sumMonto(closed)),
      convertidos: closed.length,
      conversion_rate: leads.length > 0 ? closed.length / leads.length : 0,
      by_status: byStatus,
      by_canal: groupBy(leads, l => l.canal_adquisicion),
      by_estado: groupBy(leads, l => l.estado || phoneToState(l.telefono)),
      by_vacante: groupBy(leads, l => l.vacante),
      by_presupuesto: groupBy(leads, l => fmtPresupuesto(l.presupuesto)),
    })
  }

  if (name === 'get_pendientes') {
    const { data, error } = await supabase.from('leads').select('*').order('created_at', { ascending: false })
    if (error) return errorResult(error.message)
    const leads = (data || []) as Lead[]
    const now = Date.now()
    const alerted = leads
      .map(l => ({ lead: l, alert: getLeadAlert(l, now) }))
      .filter(x => x.alert !== null)
    const groups = {
      urgentes: alerted.filter(a => a.alert!.level === 'urgent').map(a => ({ ...trimLead(a.lead), alert: a.alert })),
      follow_up: alerted.filter(a => a.alert!.kind === 'follow_up').map(a => ({ ...trimLead(a.lead), alert: a.alert })),
      llamadas: alerted.filter(a => a.alert!.kind === 'llamada_pending').map(a => ({ ...trimLead(a.lead), alert: a.alert })),
      propuestas: alerted.filter(a => a.alert!.kind === 'presentacion_pending').map(a => ({ ...trimLead(a.lead), alert: a.alert })),
    }
    const upcomingCalls = leads
      .filter(l => l.status === 'llamada_agendada' && l.llamada_at)
      .map(l => ({ lead: trimLead(l), llamada_at: l.llamada_at }))
      .filter(x => {
        const t = new Date(x.llamada_at!).getTime()
        return t >= now - 3600_000 && t <= now + 7 * 86_400_000
      })
      .sort((a, b) => new Date(a.llamada_at!).getTime() - new Date(b.llamada_at!).getTime())
    return textResult({
      total_alertas: alerted.length,
      proximas_llamadas: upcomingCalls,
      ...groups,
    })
  }

  if (name === 'ask') {
    const question = String(args.question || '').trim()
    if (!question) return errorResult('question requerida')
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) return errorResult('Falta ANTHROPIC_API_KEY en Railway')
    // Reusa el endpoint interno de AI query
    const base = process.env.NEXT_PUBLIC_APP_URL || ''
    const target = base ? `${base}/api/ai/query` : '/api/ai/query'
    try {
      const res = await fetch(target.startsWith('http') ? target : `https://crm-alarcon-production.up.railway.app/api/ai/query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      })
      const data = await res.json()
      if (data.error) return errorResult(data.error)
      return textResult({ answer: data.answer, leads_considered: data.leadsConsidered })
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : 'fetch falló')
    }
  }

  return errorResult(`Tool no implementada: ${name}`)
}
