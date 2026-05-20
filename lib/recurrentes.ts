import { createServiceClient } from './supabase'

/**
 * Live-feed de clientes recurrentes desde Google Sheets, con overrides
 * editables persistidos en clientes_recurrentes_meta.
 *
 * Cero impacto en el resto del CRM.
 */

const DEFAULT_SHEET_ID = '1rzLd59jFMvJgFbDYyaTTnYhOTLYHbeIm8xGx-6btLm4'
const START_YEAR = 2025
const START_MONTH = 10 // Noviembre (0-indexed)

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/

const DAY_MS = 86400_000

export function monthsToFetch(now = new Date()): { name: string; tab: string }[] {
  const out: { name: string; tab: string }[] = []
  let y = START_YEAR
  let m = START_MONTH
  const endY = now.getFullYear()
  const endM = now.getMonth()
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ name: `${MESES[m]} ${y}`, tab: `${MESES[m]} ${y}` })
    m++
    if (m > 11) { m = 0; y++ }
  }
  return out
}

// "Diciembre 2025" → "2025-12-01"
function tabToDate(tab: string): string | null {
  const parts = tab.split(/\s+/)
  if (parts.length !== 2) return null
  const mesIdx = MESES.findIndex(m => norm(m) === norm(parts[0]))
  if (mesIdx < 0) return null
  const year = parseInt(parts[1], 10)
  if (!year) return null
  return `${year}-${String(mesIdx + 1).padStart(2, '0')}-01`
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ }
        else inQuote = false
      } else cur += c
    } else {
      if (c === '"') inQuote = true
      else if (c === ',') { row.push(cur); cur = '' }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
      else if (c === '\r') { /* skip */ }
      else cur += c
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim()))
}

function findCol(headers: string[], patterns: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i])
    if (patterns.some(p => h.includes(p))) return i
  }
  return -1
}

function parseMonto(raw: string): number {
  if (!raw) return 0
  const digits = raw.replace(/[^0-9.,-]/g, '').replace(/,/g, '')
  const n = parseFloat(digits)
  return isNaN(n) ? 0 : n
}

/** Title Case del canal: "transferencia" / "Transferencia" / "TRANSFERENCIA" → "Transferencia". */
function normalizeCanal(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  const lower = t.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Parse a date cell into YYYY-MM-DD. Tolerant to:
 *  - DD/MM/YYYY, D/M/YYYY (con / - .)
 *  - YYYY-MM-DD
 *  - "12 de noviembre de 2025" / "12 noviembre 2025"
 *  - "12/11" (sin año → usa fallbackYear)
 * Returns null if it can't make sense of it.
 */
function parseFecha(raw: string, fallbackYear?: number): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (!s) return null

  // ISO YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) {
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10)
    if (y && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }

  // DD/MM/YYYY  or DD-MM-YYYY  or DD.MM.YYYY  (2 or 4 digit year)
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
  if (m) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10)
    let y = parseInt(m[3], 10)
    if (y < 100) y += 2000
    if (y && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }

  // "DD/MM" (no year)  → use fallbackYear
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/)
  if (m && fallbackYear) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10)
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${fallbackYear}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }

  // Spanish long form: "12 de noviembre de 2025"  /  "12 noviembre 2025"
  m = s.toLowerCase().match(/^(\d{1,2})\s*(?:de\s+)?([a-záéíóúñ]+)(?:\s+de)?\s+(\d{2,4})$/)
  if (m) {
    const d = parseInt(m[1], 10)
    const monthName = norm(m[2])
    let y = parseInt(m[3], 10)
    if (y < 100) y += 2000
    const moIdx = MESES.findIndex(x => norm(x).startsWith(monthName) || monthName.startsWith(norm(x).slice(0, 3)))
    if (moIdx >= 0 && d >= 1 && d <= 31 && y) {
      return `${y}-${String(moIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }

  // "DD <mes>" (no year) → fallbackYear
  m = s.toLowerCase().match(/^(\d{1,2})\s*(?:de\s+)?([a-záéíóúñ]+)$/)
  if (m && fallbackYear) {
    const d = parseInt(m[1], 10)
    const monthName = norm(m[2])
    const moIdx = MESES.findIndex(x => norm(x).startsWith(monthName) || monthName.startsWith(norm(x).slice(0, 3)))
    if (moIdx >= 0 && d >= 1 && d <= 31) {
      return `${fallbackYear}-${String(moIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }

  // Last resort: let Date.parse() try (handles "Nov 12, 2025" etc.)
  const t = Date.parse(s)
  if (!isNaN(t)) {
    const d = new Date(t)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  return null
}

/**
 * Extrae email del campo cliente cuando viene como "Nombre | email@dominio".
 * También cubre separadores · — , / \ y guiones.
 */
function splitNameEmail(raw: string): { name: string; email: string | null } {
  if (!raw) return { name: '', email: null }
  const m = raw.match(EMAIL_RE)
  if (!m) return { name: raw.trim(), email: null }
  const email = m[0]
  let name = raw.replace(email, '').trim()
  name = name.replace(/[|·—\-,/\\]+$/, '').replace(/^[|·—\-,/\\]+/, '').trim()
  name = name.replace(/\s+/g, ' ')
  return { name: name || email, email }
}

/** Un pago individual extraído del sheet. */
export type Pago = {
  fecha: string | null   // YYYY-MM-DD
  monto: number
  canal: string | null
  mes: string            // "Diciembre 2025" — para trazabilidad
}

export type EstatusCliente = 'activo' | 'renovar' | 'churn'
export type TipoCliente = 'pequeño' | 'mediano' | 'grande' | 'corporativo'
export type TipoContrato = 'mensual' | 'semestral' | 'anual'

/** Thresholds de tipoCliente (basado en ticket promedio). Ajustable. */
const TIER_THRESHOLDS = {
  pequeño:     5_000,    // <= 5k
  mediano:    20_000,    // <= 20k
  grande:     50_000,    // <= 50k
  // corporativo: > 50k
} as const

function tipoClienteFromAvg(avgTicket: number): TipoCliente {
  if (avgTicket <= TIER_THRESHOLDS.pequeño)  return 'pequeño'
  if (avgTicket <= TIER_THRESHOLDS.mediano)  return 'mediano'
  if (avgTicket <= TIER_THRESHOLDS.grande)   return 'grande'
  return 'corporativo'
}

/**
 * Estatus por última aparición:
 *  - activo:  paga en los últimos 35 días (ventana de un mes con buffer)
 *  - renovar: 35–60 días — ya vence pronto, foco
 *  - churn:   > 60 días sin pagar
 */
function estatusFromUltima(ultima: string | null, now = Date.now()): EstatusCliente {
  if (!ultima) return 'churn'
  const t = new Date(ultima + 'T00:00:00').getTime()
  const days = (now - t) / DAY_MS
  if (days <= 35) return 'activo'
  if (days <= 60) return 'renovar'
  return 'churn'
}

/**
 * Tipo de contrato a partir de la mediana de gaps entre pagos.
 *  - 1 pago solo  → mensual (default optimista)
 *  - gap mediano ≤ 60 d  → mensual
 *  - 120–210 d   → semestral
 *  - 300–400 d   → anual
 *  - else        → mensual (default)
 */
function tipoContratoFromPagos(pagos: Pago[]): TipoContrato {
  if (pagos.length < 2) return 'mensual'
  const fechas = pagos.map(p => p.fecha).filter((x): x is string => !!x)
  if (fechas.length < 2) return 'mensual'
  const sorted = [...fechas].sort()
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const t1 = new Date(sorted[i - 1] + 'T00:00:00').getTime()
    const t2 = new Date(sorted[i] + 'T00:00:00').getTime()
    gaps.push((t2 - t1) / DAY_MS)
  }
  gaps.sort((a, b) => a - b)
  const median = gaps.length % 2
    ? gaps[Math.floor(gaps.length / 2)]
    : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2
  if (median <= 60)  return 'mensual'
  if (median <= 210) return 'semestral'
  if (median <= 400) return 'anual'
  return 'mensual'
}

/** Mes (1-12) de la próxima renovación para contratos largos. null para mensual. */
function mesRenovacionDe(pagos: Pago[], contrato: TipoContrato): number | null {
  if (contrato === 'mensual') return null
  const fechas = pagos.map(p => p.fecha).filter((x): x is string => !!x).sort()
  if (!fechas.length) return null
  const last = new Date(fechas[fechas.length - 1] + 'T00:00:00')
  const offset = contrato === 'semestral' ? 6 : 12
  const next = new Date(last)
  next.setMonth(next.getMonth() + offset)
  return next.getMonth() + 1  // 1-12
}

export type ClienteRecurrente = {
  key: string
  cliente: string
  email: string | null
  fecha_inicio: string | null
  ultima_aparicion: string | null
  total_pagado: number
  veces: number
  canales: string[]
  meses: string[]              // meses únicos (=== meses_renovando count)
  meses_renovando: number      // alias = meses.length
  pagos: Pago[]                // historial completo
  estatus: EstatusCliente
  tipo_cliente: TipoCliente
  ticket_promedio: number
  tipo_contrato: TipoContrato
  mes_renovacion: number | null  // 1-12 para semestral/anual
  notas: string | null
  has_override: boolean
  hidden: boolean
}

type FetchOpts = { sheetId?: string; signal?: AbortSignal }

async function fetchTabCsv(sheetId: string, tab: string, signal?: AbortSignal): Promise<string | null> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`
  try {
    const res = await fetch(url, { signal, cache: 'no-store', redirect: 'follow' })
    if (!res.ok) return null
    const text = await res.text()
    if (text.startsWith('<')) return null
    return text
  } catch {
    return null
  }
}

type Override = {
  key: string
  nombre: string | null
  email: string | null
  fecha_inicio: string | null
  canal: string | null
  notas: string | null
  hidden: boolean | null
}

async function fetchOverrides(): Promise<Map<string, Override>> {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('clientes_recurrentes_meta')
      .select('key,nombre,email,fecha_inicio,canal,notas,hidden')
    if (error || !data) return new Map()
    return new Map((data as Override[]).map(d => [d.key, d]))
  } catch {
    return new Map()
  }
}

/**
 * Estricto: "Fer" como primera palabra de QUIÉN. NO matchea "Fernanda"
 * ni "Fernando". Sí matchea "Fer", "Fer Alarcon", "FER", "fer alarcon".
 */
function isFer(quien: string): boolean {
  const firstWord = norm(quien).split(/\s+/)[0]
  return firstWord === 'fer'
}

export async function fetchRecurrentes(opts: FetchOpts = {}): Promise<{
  clientes: ClienteRecurrente[]
  meses_leidos: string[]
  meses_intentados: string[]
  total_pagado_global: number
  hidden_count: number
  generated_at: string
}> {
  const sheetId = opts.sheetId || process.env.RECURRENTES_SHEET_ID || DEFAULT_SHEET_ID
  const months = monthsToFetch()
  const intentados = months.map(m => m.name)

  const [csvResults, overrides] = await Promise.all([
    Promise.all(months.map(async m => ({
      name: m.name,
      tabDate: tabToDate(m.tab),
      csv: await fetchTabCsv(sheetId, m.tab, opts.signal),
    }))),
    fetchOverrides(),
  ])

  // map intermedio: por cliente, acumulamos pagos crudos.
  type Acc = {
    key: string
    cliente: string
    email: string | null
    canales: Set<string>
    meses: Set<string>
    pagos: Pago[]
  }
  const map = new Map<string, Acc>()
  const mesesLeidos: string[] = []

  for (const { name, tabDate, csv } of csvResults) {
    if (!csv) continue
    const rows = parseCsv(csv)
    if (rows.length < 2) continue

    const headers = rows[0]
    const idxQuien = findCol(headers, ['quien', 'responsable', 'vendedor', 'owner', 'coach'])
    const idxCliente = findCol(headers, ['cliente', 'empresa', 'nombre', 'cuenta', 'company'])
    const idxEmail = findCol(headers, ['email', 'correo', 'mail'])
    const idxMonto = findCol(headers, ['monto', 'importe', 'total', 'cantidad', 'amount', 'precio', 'pago'])
    const idxCanal = findCol(headers, ['canal', 'metodo', 'forma', 'via'])

    // Fecha: 1) header explícito; 2) fallback a col A si su primera celda parsea como fecha.
    let idxFecha = findCol(headers, ['fecha', 'date', 'dia', 'día'])
    const tabYear = tabDate ? parseInt(tabDate.slice(0, 4), 10) : undefined
    if (idxFecha < 0 && rows.length > 1) {
      const sample = (rows[1][0] || '').trim()
      if (parseFecha(sample, tabYear)) idxFecha = 0
    }

    if (idxQuien < 0) continue
    mesesLeidos.push(name)

    for (const row of rows.slice(1)) {
      const quien = (row[idxQuien] || '').trim()
      if (!isFer(quien)) continue

      const clienteRaw = idxCliente >= 0 ? (row[idxCliente] || '').trim() : ''
      const emailFromCol = idxEmail >= 0
        ? (row[idxEmail] || '').match(EMAIL_RE)?.[0] || null
        : null
      const { name: cleanName, email: emailFromName } = splitNameEmail(clienteRaw)
      const email = emailFromCol || emailFromName
      const monto = idxMonto >= 0 ? parseMonto(row[idxMonto] || '') : 0
      const canalRaw = idxCanal >= 0 ? (row[idxCanal] || '').trim() : ''
      const canal = canalRaw ? normalizeCanal(canalRaw) : ''
      const fechaRaw = idxFecha >= 0 ? (row[idxFecha] || '').trim() : ''
      const fecha = parseFecha(fechaRaw, tabYear) || tabDate

      if (!cleanName && !email) continue

      const key = email ? email.toLowerCase() : norm(cleanName)
      const acc = map.get(key) || {
        key,
        cliente: cleanName || email || '—',
        email,
        canales: new Set<string>(),
        meses: new Set<string>(),
        pagos: [],
      }
      acc.pagos.push({ fecha, monto, canal: canal || null, mes: name })
      if (canal) acc.canales.add(canal)
      acc.meses.add(name)
      if (!acc.email && email) acc.email = email
      if ((!acc.cliente || acc.cliente === acc.email) && cleanName && cleanName !== email) {
        acc.cliente = cleanName
      }
      map.set(key, acc)
    }
  }

  // Derivar campos por cliente
  const now = Date.now()
  const clientes: ClienteRecurrente[] = Array.from(map.values()).map(acc => {
    const pagos = acc.pagos
    const total_pagado = pagos.reduce((s, p) => s + p.monto, 0)
    const veces = pagos.length
    const ticket_promedio = veces > 0 ? total_pagado / veces : 0
    const fechas = pagos.map(p => p.fecha).filter((x): x is string => !!x).sort()
    const fecha_inicio = fechas.length ? fechas[0] : null
    const ultima_aparicion = fechas.length ? fechas[fechas.length - 1] : null
    const estatus = estatusFromUltima(ultima_aparicion, now)
    const tipo_cliente = tipoClienteFromAvg(ticket_promedio)
    const tipo_contrato = tipoContratoFromPagos(pagos)
    const mes_renovacion = mesRenovacionDe(pagos, tipo_contrato)
    return {
      key: acc.key,
      cliente: acc.cliente,
      email: acc.email,
      fecha_inicio,
      ultima_aparicion,
      total_pagado,
      veces,
      canales: Array.from(acc.canales),
      meses: Array.from(acc.meses),
      meses_renovando: acc.meses.size,
      pagos: [...pagos].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '')),
      estatus,
      tipo_cliente,
      ticket_promedio,
      tipo_contrato,
      mes_renovacion,
      notas: null,
      has_override: false,
      hidden: false,
    }
  })

  // Aplicar overrides editables
  for (const c of clientes) {
    const ov = overrides.get(c.key)
    if (!ov) continue
    c.has_override = true
    if (ov.nombre) c.cliente = ov.nombre
    if (ov.email) c.email = ov.email
    if (ov.fecha_inicio) c.fecha_inicio = ov.fecha_inicio
    if (ov.canal) c.canales = [ov.canal]
    c.notas = ov.notas
    c.hidden = ov.hidden === true
  }

  clientes.sort((a, b) => b.total_pagado - a.total_pagado)
  const total_pagado_global = clientes
    .filter(c => !c.hidden)
    .reduce((s, c) => s + c.total_pagado, 0)
  const hidden_count = clientes.filter(c => c.hidden).length

  return {
    clientes,
    meses_leidos: mesesLeidos,
    meses_intentados: intentados,
    total_pagado_global,
    hidden_count,
    generated_at: new Date().toISOString(),
  }
}
