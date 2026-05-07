export type Presupuesto = 'none' | '100_to_1000' | '2000_to_5000' | '10000_plus'

export const PRESUPUESTO_VALUES: Presupuesto[] = ['none', '100_to_1000', '2000_to_5000', '10000_plus']

export const PRESUPUESTO_LABELS: Record<Presupuesto, string> = {
  none: 'No invierte',
  '100_to_1000': '$100 a $1,000',
  '2000_to_5000': '$2,000 a $5,000',
  '10000_plus': '+$10,000',
}

export const PRESUPUESTO_COLORS: Record<Presupuesto, string> = {
  none: '#606078',
  '100_to_1000': '#4ea8f5',
  '2000_to_5000': '#a594ff',
  '10000_plus': '#22d68a',
}

export function fmtPresupuesto(p: string | null | undefined): string {
  if (!p) return 'No registrado'
  return PRESUPUESTO_LABELS[p as Presupuesto] || p
}

/** Parse the raw value out of a Slack message — defensive against case / whitespace */
export function normalizePresupuesto(raw: string | null | undefined): Presupuesto | null {
  if (!raw) return null
  const v = raw.trim().toLowerCase()
  if ((PRESUPUESTO_VALUES as string[]).includes(v)) return v as Presupuesto
  return null
}
