import type { Lead } from './supabase'
import { phoneToState } from './lada'
import { startOfWeek, subWeeks, startOfMonth, subMonths } from 'date-fns'

const PIPELINE_CLOSED: Lead['status'][] = ['convertido', 'cliente_recurrente']
const PIPELINE_CLOSING: Lead['status'][] = ['presentacion_enviada', 'espera_aprobacion']
const DEFAULT_MONTO = 1160

const sumMonto = (rows: Lead[]) => rows.reduce((a, l) => a + (l.monto ?? DEFAULT_MONTO), 0)

/**
 * Pre-computa stats útiles para que el LLM no haga matemáticas.
 * Devuelve un objeto compacto que se serializa al prompt.
 */
export function computeInsightInputs(leads: Lead[]) {
  const now = new Date()
  const weekStart = startOfWeek(now, { weekStartsOn: 1 })
  const lastWeekStart = startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 })
  const monthStart = startOfMonth(now)
  const lastMonthStart = startOfMonth(subMonths(now, 1))

  const inRange = (l: Lead, from: Date, to: Date) => {
    const t = new Date(l.created_at).getTime()
    return t >= from.getTime() && t < to.getTime()
  }

  const thisWeek = leads.filter(l => inRange(l, weekStart, now))
  const lastWeek = leads.filter(l => inRange(l, lastWeekStart, weekStart))
  const thisMonth = leads.filter(l => inRange(l, monthStart, now))
  const lastMonth = leads.filter(l => inRange(l, lastMonthStart, monthStart))

  const closeRate = (rows: Lead[]) => rows.length > 0
    ? rows.filter(l => PIPELINE_CLOSED.includes(l.status)).length / rows.length
    : 0

  const byCanal = (rows: Lead[]) => {
    const map = new Map<string, { leads: number; cerrados: number; pipelineCerrado: number }>()
    for (const l of rows) {
      const k = l.canal_adquisicion || 'sin canal'
      const e = map.get(k) || { leads: 0, cerrados: 0, pipelineCerrado: 0 }
      e.leads += 1
      if (PIPELINE_CLOSED.includes(l.status)) {
        e.cerrados += 1
        e.pipelineCerrado += l.monto ?? DEFAULT_MONTO
      }
      map.set(k, e)
    }
    return Array.from(map.entries()).map(([canal, v]) => ({
      canal, ...v,
      conversion: v.leads > 0 ? v.cerrados / v.leads : 0,
    }))
  }

  const byEstado = (rows: Lead[]) => {
    const map = new Map<string, number>()
    for (const l of rows) {
      const k = l.estado || phoneToState(l.telefono) || 'sin estado'
      map.set(k, (map.get(k) || 0) + 1)
    }
    return Array.from(map.entries())
      .map(([estado, leads]) => ({ estado, leads }))
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 5)
  }

  const stuckContactado = leads.filter(l => {
    if (l.status !== 'contactado') return false
    const ts = l.ultimo_contacto || l.status_changed_at || l.updated_at
    if (!ts) return false
    const days = (Date.now() - new Date(ts).getTime()) / 86_400_000
    return days >= 5
  })

  return {
    period: {
      thisWeek: weekStart.toISOString().slice(0, 10),
      lastWeek: lastWeekStart.toISOString().slice(0, 10),
      thisMonth: monthStart.toISOString().slice(0, 10),
      today: now.toISOString().slice(0, 10),
    },
    counts: {
      total: leads.length,
      thisWeek: thisWeek.length,
      lastWeek: lastWeek.length,
      thisMonth: thisMonth.length,
      lastMonth: lastMonth.length,
      stuckContactado: stuckContactado.length,
    },
    pipelineCerrado: {
      thisMonth: sumMonto(thisMonth.filter(l => PIPELINE_CLOSED.includes(l.status))),
      lastMonth: sumMonto(lastMonth.filter(l => PIPELINE_CLOSED.includes(l.status))),
      goal: 200000,
    },
    pipelineEnCierre: sumMonto(leads.filter(l => PIPELINE_CLOSING.includes(l.status))),
    conversion: {
      thisMonth: closeRate(thisMonth),
      lastMonth: closeRate(lastMonth),
    },
    canalThisMonth: byCanal(thisMonth),
    estadoThisMonth: byEstado(thisMonth),
  }
}

export const INSIGHTS_SYSTEM_PROMPT = `Eres un coach de ventas analítico para Fer (dueño de Chambas, vende un servicio de reclutamiento — pipeline mensual objetivo MXN $200,000).

Te paso stats pre-computadas del CRM. NO HAGAS MATH a mano: las cifras ya vienen.

Devuelvé entre 3 y 5 insights cortos en formato bullet markdown ("- "). Reglas:
- Cada bullet máximo 2 líneas, accionable, en español de México.
- Empezá cada bullet con UN emoji que comunique el tono (📈 mejora, 📉 alerta, 🎯 oportunidad, 🔥 urgente, 💡 patrón, ✅ éxito).
- Hablá en segunda persona (vos / tú).
- Comparativas: si esta semana < semana pasada en algo, decílo. Si un canal convierte mejor, decílo. Si hay leads atascados, alertá.
- Concretá con números (counts, %, MXN con $ y comas) — no abstracciones.
- NO repitas obviedades ("hay X leads"). Solo insights que ayuden a decidir qué hacer.
- NO uses headers (#), solo bullets. NO listes leads individuales.
- Si los datos son insuficientes (ej. semana recién empezada), decilo en 1 bullet y ya.

Output: solo los bullets. Sin preámbulo ni cierre.`
