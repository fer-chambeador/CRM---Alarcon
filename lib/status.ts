import type { Lead } from './supabase'

export const STATUS_LABELS: Record<Lead['status'], string> = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  llamada_agendada: 'Llamada agendada',
  no_show_llamada: 'No show llamada',
  presentacion_enviada: 'Propuesta enviada',
  espera_aprobacion: 'Espera de aprobación',
  convertido: 'Convertido',
  cliente_recurrente: 'Cliente recurrente',
  descartado: 'Descartado',
}

export const STATUS_ORDER: Lead['status'][] = [
  'nuevo',
  'contactado',
  'llamada_agendada',
  'no_show_llamada',
  'presentacion_enviada',
  'espera_aprobacion',
  'convertido',
  'cliente_recurrente',
  'descartado',
]

export const PIPELINE_CLOSING: Lead['status'][] = ['presentacion_enviada', 'espera_aprobacion']
export const PIPELINE_CLOSED: Lead['status'][] = ['convertido', 'cliente_recurrente']

export const DEFAULT_MONTO = 1160

export function statusColor(s: Lead['status']): string {
  return ({
    nuevo: '#4ea8f5',
    contactado: '#f5c842',
    llamada_agendada: '#f5914e',
    no_show_llamada: '#f05a5a',
    presentacion_enviada: '#a594ff',
    espera_aprobacion: '#ffba3d',
    convertido: '#22d68a',
    cliente_recurrente: '#22d68a',
    descartado: '#606078',
  } as Record<Lead['status'], string>)[s]
}

export const CURRENCY = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN', maximumFractionDigits: 0,
})
export function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  return CURRENCY.format(n)
}
export function fmtPct(n: number): string {
  return isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—'
}

export const sumMonto = (rows: Lead[]) => rows.reduce((a, l) => a + (l.monto ?? DEFAULT_MONTO), 0)

// ─── Business rules / alerts ────────────────────────────────────────────────
export type AlertKind = 'follow_up' | 'last_chance' | 'llamada_pending' | 'presentacion_pending'
export type AlertAction = {
  label: string
  status?: Lead['status']
  incrementarContacto?: boolean
}
export type LeadAlert = {
  kind: AlertKind
  level: 'warning' | 'urgent'
  text: string
  hours: number
  actions: AlertAction[]
}

const HOUR = 36e5
const BUSINESS_HOURS_THRESHOLD = 72  // 9 working days of 8h

/**
 * Hours of business time elapsed between two timestamps.
 * Business hours = Mon–Fri, 10:00–18:00 (local time).
 * Weekends and non-business hours don't count toward the total.
 */
export function businessHoursElapsed(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0
  let total = 0
  const cur = new Date(fromMs)
  for (let i = 0; i < 600 && cur.getTime() < toMs; i++) {
    const day = cur.getDay() // 0=Sun, 6=Sat
    if (day === 0 || day === 6) {
      // jump to next Monday 10:00
      cur.setDate(cur.getDate() + (day === 0 ? 1 : 2))
      cur.setHours(10, 0, 0, 0)
      continue
    }
    const start = new Date(cur); start.setHours(10, 0, 0, 0)
    const end = new Date(cur); end.setHours(18, 0, 0, 0)
    if (cur.getTime() < start.getTime()) {
      cur.setTime(start.getTime())
      continue
    }
    if (cur.getTime() >= end.getTime()) {
      cur.setDate(cur.getDate() + 1)
      cur.setHours(10, 0, 0, 0)
      continue
    }
    const stop = Math.min(end.getTime(), toMs)
    total += (stop - cur.getTime()) / HOUR
    cur.setTime(stop)
    if (cur.getTime() < toMs) {
      cur.setDate(cur.getDate() + 1)
      cur.setHours(10, 0, 0, 0)
    }
  }
  return total
}

/**
 * Compute the alert (if any) for a lead.
 *
 * Rules:
 *  - contactado: clock starts at ultimo_contacto (or status_changed_at fallback).
 *      Trigger every 72 BUSINESS hours (Mon-Fri 10:00-18:00):
 *        veces=1 → "Pasá a 2do contacto"
 *        veces=2 → "Pasá a 3er contacto"
 *        veces=3 → "Descartá por intentos" (urgent)
 *  - llamada_agendada → 24 h calendario: ¿propuesta enviada o no show?
 *  - presentacion_enviada → 48 h calendario: ¿convertido o espera de aprobación?
 */
export function getLeadAlert(lead: Lead, now: number = Date.now()): LeadAlert | null {
  if (lead.status === 'contactado') {
    const ts = lead.ultimo_contacto
      ? new Date(lead.ultimo_contacto).getTime()
      : new Date(lead.status_changed_at || lead.updated_at).getTime()
    const bizHours = businessHoursElapsed(ts, now)
    const calHours = (now - ts) / HOUR
    if (bizHours < BUSINESS_HOURS_THRESHOLD) return null

    const veces = Math.max(1, lead.veces_contactado || 1)
    if (veces === 1) {
      return {
        kind: 'follow_up', level: 'warning', hours: calHours,
        text: '72 h hábiles sin avance — pasá a 2do contacto',
        actions: [{ label: 'Pasá a 2do contacto', incrementarContacto: true }],
      }
    }
    if (veces === 2) {
      return {
        kind: 'follow_up', level: 'warning', hours: calHours,
        text: '72 h hábiles sin avance — pasá a 3er contacto',
        actions: [{ label: 'Pasá a 3er contacto', incrementarContacto: true }],
      }
    }
    // veces >= 3 → último intento
    return {
      kind: 'last_chance', level: 'urgent', hours: calHours,
      text: '72 h hábiles sin avance tras 3er contacto — descartá por intentos',
      actions: [{ label: 'Descartar por intentos', status: 'descartado' }],
    }
  }

  // Other branches keep calendar time (real-world deadlines)
  const ts = lead.status_changed_at ? new Date(lead.status_changed_at).getTime() : new Date(lead.updated_at).getTime()
  const hours = (now - ts) / HOUR

  if (lead.status === 'llamada_agendada') {
    const callActions = [
      { label: 'Propuesta enviada', status: 'presentacion_enviada' as Lead['status'] },
      { label: 'No show', status: 'no_show_llamada' as Lead['status'] },
    ]
    // Si capturaste la fecha/hora exacta, alertá en torno a esa hora
    if (lead.llamada_at) {
      const callMs = new Date(lead.llamada_at).getTime()
      const minsUntil = (callMs - now) / 60000
      if (minsUntil > 0 && minsUntil <= 60) {
        return {
          kind: 'llamada_pending', level: 'urgent', hours: 0,
          text: `Llamada en ${Math.round(minsUntil)} min`,
          actions: callActions,
        }
      }
      const hoursAfter = (now - callMs) / HOUR
      if (hoursAfter >= 1) {
        return {
          kind: 'llamada_pending', level: 'warning', hours: hoursAfter,
          text: `La llamada fue hace ${hoursAfter < 24 ? Math.round(hoursAfter) + ' h' : Math.floor(hoursAfter / 24) + ' días'}. ¿Cómo fue?`,
          actions: callActions,
        }
      }
    } else if (hours >= 24) {
      // Fallback legacy si no se capturó la hora exacta
      return {
        kind: 'llamada_pending', level: 'warning', hours,
        text: '24 h desde que agendaste. ¿Cómo fue?',
        actions: callActions,
      }
    }
  }

  if (lead.status === 'presentacion_enviada' && hours >= 48) {
    return {
      kind: 'presentacion_pending', level: 'warning', hours,
      text: '48 h desde la propuesta. ¿Resultado?',
      actions: [
        { label: 'Convertido', status: 'convertido' },
        { label: 'Espera aprobación', status: 'espera_aprobacion' },
      ],
    }
  }

  return null
}

export function alertColor(level: 'warning' | 'urgent'): string {
  return level === 'urgent' ? '#f05a5a' : '#f5c842'
}

export function fmtHours(h: number): string {
  if (h < 24) return `hace ${Math.round(h)} h`
  const d = Math.floor(h / 24)
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`
}
