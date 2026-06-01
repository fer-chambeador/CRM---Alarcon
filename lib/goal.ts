/**
 * Metas de pipeline cerrado. V1 hardcoded; cuando lo necesites movemos
 * estos números a una tabla de Supabase y los editás desde la UI.
 */
export const WEEKLY_GOAL  = 50_000
export const MONTHLY_GOAL = 200_000

/**
 * Días hábiles del mes (lun-vie). Aprox. 22 al mes. Usamos esto para
 * derivar metas de "hoy" y "esta semana" si el filtro de periodo es
 * más corto que un mes.
 */
const BUSINESS_DAYS_PER_MONTH = 22

export type GoalPeriod = 'todo' | 'hoy' | 'semana' | 'mes' | 'mes-pasado' | 'custom'

/** Meta para un periodo dado del filtro de tiempo. */
export function goalForPeriod(period: GoalPeriod): number {
  switch (period) {
    case 'todo':       return MONTHLY_GOAL   // referencia: mes en curso
    case 'hoy':        return Math.round(WEEKLY_GOAL / 5)   // 50k/5 días hábiles = 10k
    case 'semana':     return WEEKLY_GOAL
    case 'mes':        return MONTHLY_GOAL
    case 'mes-pasado': return MONTHLY_GOAL
    // Rango custom: sin meta predefinida — la card muestra el valor sin progress bar.
    case 'custom':     return 0
  }
}

/** Label de la meta para mostrar en la card ("meta semanal", etc.). */
export function goalLabel(period: GoalPeriod): string {
  switch (period) {
    case 'todo':       return 'meta mensual'
    case 'hoy':        return 'meta diaria'
    case 'semana':     return 'meta semanal'
    case 'mes':        return 'meta mensual'
    case 'mes-pasado': return 'meta mensual'
    case 'custom':     return 'rango personalizado'
  }
}
