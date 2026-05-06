import type { Lead } from './supabase'

export const STATUS_LABELS: Record<Lead['status'], string> = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  llamada_agendada: 'Llamada agendada',
  no_show_llamada: 'No show llamada',
  presentacion_enviada: 'Presentación enviada',
  espera_aprobacion: 'Espera de aprobación',
  convertido: 'Convertido',
  cliente_recurrente: 'Cliente recurrente',
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
export type AlertAction = { label: string; status: Lead['status'] }
export type LeadAlert = {
  kind: AlertKind
  level: 'warning' | 'urgent'
  text: string
  hours: number
  actions: AlertAction[]
}

const HOUR = 36e5

/**
 * Compute the alert (if any) for a lead based on how long it has been
 * sitting in its current status.
 *
 * Rules:
 *  - contactado → 48h: follow up; 96h: último seguimiento
 *  - llamada_agendada → 24h: ¿presentación enviada o no show?
 *  - presentacion_enviada → 48h: ¿convertido o espera de aprobación?
 */
export function getLeadAlert(lead: Lead, now: number = Date.now()): LeadAlert | null {
  const ts = lead.status_changed_at ? new Date(lead.status_changed_at).getTime() : new Date(lead.updated_at).getTime()
  const hours = (now - ts) / HOUR

  if (lead.status === 'contactado') {
    if (hours >= 96) return {
      kind: 'last_chance', level: 'urgent', hours,
      text: 'Último seguimiento — 96 h sin avance',
      actions: [
        { label: 'Llamada agendada', status: 'llamada_agendada' },
        { label: 'Descartar', status: 'no_show_llamada' },
      ],
    }
    if (hours >= 48) return {
      kind: 'follow_up', level: 'warning', hours,
      text: 'Follow up — 48 h sin avance',
      actions: [
        { label: 'Llamada agendada', status: 'llamada_agendada' },
      ],
    }
  }

  if (lead.status === 'llamada_agendada' && hours >= 24) {
    return {
      kind: 'llamada_pending', level: 'warning', hours,
      text: '24 h desde que agendaste. ¿Cómo fue?',
      actions: [
        { label: 'Presentación enviada', status: 'presentacion_enviada' },
        { label: 'No show', status: 'no_show_llamada' },
      ],
    }
  }

  if (lead.status === 'presentacion_enviada' && hours >= 48) {
    return {
      kind: 'presentacion_pending', level: 'warning', hours,
      text: '48 h desde la presentación. ¿Resultado?',
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
