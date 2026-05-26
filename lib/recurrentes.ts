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
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^﻿/, '')  // BOM (gviz csv lo mete al inicio)
    .replace(/ /g, ' ') // non-breaking space → space normal
    .trim()

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

  // Sanity: si tabYear está definido, el año parseado debe estar a
  // ±2 años. Si no, usamos tabYear. Esto corta errores tipo "01/10/01"
  // que mi parser leía como 2001 cuando realmente es 2026.
  const inferYear = (y: number): number => {
    if (!fallbackYear) return y
    if (y >= 1900 && y <= 2100 && Math.abs(y - fallbackYear) <= 2) return y
    return fallbackYear
  }

  // gviz CSV format para celdas con formato fecha: "Date(2026,0,29)"
  let m = s.match(/^Date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})\)$/)
  if (m) {
    const y = inferYear(parseInt(m[1], 10)), mo = parseInt(m[2], 10) + 1, d = parseInt(m[3], 10)
    if (y && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
  }

  // ISO YYYY-MM-DD or YYYY/MM/DD
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) {
    const y = inferYear(parseInt(m[1], 10)), mo = parseInt(m[2], 10), d = parseInt(m[3], 10)
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
    y = inferYear(y)
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

  // Last resort: Date.parse(). Solo aceptar si el año cae cerca del tabYear.
  const t = Date.parse(s)
  if (!isNaN(t)) {
    const d = new Date(t)
    const y = d.getFullYear()
    if (!fallbackYear || (y >= 1900 && y <= 2100 && Math.abs(y - fallbackYear) <= 2)) {
      return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
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
 * Estatus por última aparición — ajustado al tipo de contrato.
 *
 *  mensual:    activo ≤30 d / churn >30 d  (binario, regla del user)
 *  semestral:  activo ≤210 d / renovar ≤240 d / churn >240 d
 *  anual:      activo ≤400 d / renovar ≤430 d / churn >430 d
 *
 * Para mensual no hay estado intermedio "renovar" — el usuario quiere
 * que el corte sea 30 días estrictos.
 */
function estatusFromUltima(
  ultima: string | null,
  contrato: TipoContrato,
  now = Date.now(),
): EstatusCliente {
  if (!ultima) return 'churn'
  const t = new Date(ultima + 'T00:00:00').getTime()
  const days = (now - t) / DAY_MS
  if (contrato === 'mensual') {
    return days <= 30 ? 'activo' : 'churn'
  }
  const T = {
    semestral: { activo: 210, renovar: 240 },
    anual:     { activo: 400, renovar: 430 },
  }[contrato]
  if (days <= T.activo)  return 'activo'
  if (days <= T.renovar) return 'renovar'
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
  estatus: EstatusCliente | null
  tipo_cliente: TipoCliente | null
  tipo_contrato: TipoContrato | null
  meses_renovando: number | null
}

async function fetchOverrides(): Promise<Map<string, Override>> {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('clientes_recurrentes_meta')
      .select('key,nombre,email,fecha_inicio,canal,notas,hidden,estatus,tipo_cliente,tipo_contrato,meses_renovando')
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

/**
 * Sondeo a hojas de renovaciones del sheet. Prueba nombres comunes y
 * devuelve filas que tengan formato { cliente, estatus, comentario }.
 *
 * Buscamos en headers columnas: cliente/empresa/nombre, estatus/status/estado,
 * notas/comentario/comentarios/observaciones, renovo/renueva/renovación.
 */
type RenovacionInfo = {
  cliente_key: string         // normalized name to match con cliente.key
  estatus?: EstatusCliente
  notas?: string
}

async function fetchRenovaciones(sheetId: string, signal?: AbortSignal): Promise<RenovacionInfo[]> {
  const now = new Date()
  // Nombres candidatos — probamos varios formatos comunes.
  const candidates = new Set<string>([
    'Renovaciones',
    'Renovaciones x mes',
    'Renovaciones por mes',
    `Renovaciones ${now.getFullYear()}`,
    `Renovaciones ${now.getFullYear() - 1}`,
  ])
  // También probamos "Renovaciones <Mes> <Año>" para los últimos meses
  for (let i = 0; i < 6; i++) {
    const d = new Date(now); d.setMonth(d.getMonth() - i)
    candidates.add(`Renovaciones ${MESES[d.getMonth()]} ${d.getFullYear()}`)
  }

  const results: RenovacionInfo[] = []
  for (const tab of Array.from(candidates)) {
    const csv = await fetchTabCsv(sheetId, tab, signal)
    if (!csv) continue
    const rows = parseCsv(csv)
    if (rows.length < 2) continue
    const headers = rows[0]
    const idxCliente = findCol(headers, ['cliente', 'empresa', 'nombre', 'cuenta', 'company'])
    const idxEstatus = findCol(headers, ['estatus', 'status', 'estado', 'renovo', 'renueva', 'renovacion', 'renovación'])
    const idxNotas   = findCol(headers, ['notas', 'comentario', 'comentarios', 'observacion', 'observaciones', 'detalle'])
    if (idxCliente < 0) continue

    for (const row of rows.slice(1)) {
      const clienteRaw = (row[idxCliente] || '').trim()
      if (!clienteRaw) continue
      const { name: cleanName, email } = splitNameEmail(clienteRaw)
      const cliente_key = email ? email.toLowerCase() : norm(cleanName)
      if (!cliente_key) continue

      const estatusRaw = idxEstatus >= 0 ? norm(row[idxEstatus] || '') : ''
      let estatus: EstatusCliente | undefined
      if (estatusRaw) {
        if (/(activo|renov[oó]|si|sí|✓)/.test(estatusRaw))       estatus = 'activo'
        else if (/(por renovar|pendiente|renovar)/.test(estatusRaw)) estatus = 'renovar'
        else if (/(churn|baj[ao]|cancel|no|✗|x)/.test(estatusRaw))    estatus = 'churn'
      }
      const notas = idxNotas >= 0 ? (row[idxNotas] || '').trim() || undefined : undefined

      results.push({ cliente_key, estatus, notas })
    }
  }
  return results
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

  const [csvResults, overrides, renovaciones] = await Promise.all([
    Promise.all(months.map(async m => ({
      name: m.name,
      tabDate: tabToDate(m.tab),
      csv: await fetchTabCsv(sheetId, m.tab, opts.signal),
    }))),
    fetchOverrides(),
    fetchRenovaciones(sheetId, opts.signal),
  ])

  // Agrupar renovaciones por cliente_key. Si hay múltiples filas para el
  // mismo cliente (un mes los pongo activo, otro mes churn), priorizamos
  // la más reciente que tenga estatus, y concatenamos las notas.
  const renovByKey = new Map<string, RenovacionInfo>()
  for (const r of renovaciones) {
    const existing = renovByKey.get(r.cliente_key)
    if (existing) {
      // último estatus gana, notas se concatenan
      if (r.estatus) existing.estatus = r.estatus
      if (r.notas) existing.notas = existing.notas
        ? `${existing.notas}\n${r.notas}`
        : r.notas
    } else {
      renovByKey.set(r.cliente_key, { ...r })
    }
  }

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

    // Fecha: 1) header explícito; 2) si no, detectar por contenido la
    //    columna que tenga mayor proporción de celdas parseables como fecha.
    //    Más agresivo ahora: prueba TODAS las columnas, threshold 30%,
    //    necesita mínimo 2 hits.
    let idxFecha = findCol(headers, ['fecha', 'date', 'dia', 'día'])
    const tabYear = tabDate ? parseInt(tabDate.slice(0, 4), 10) : undefined
    if (idxFecha < 0 && rows.length > 1) {
      const sampleLimit = Math.min(rows.length, 50)
      const maxCol = headers.length
      let bestCol = -1
      let bestRatio = 0
      let bestHits = 0
      for (let col = 0; col < maxCol; col++) {
        let hits = 0
        let total = 0
        for (let r = 1; r < sampleLimit; r++) {
          const cell = (rows[r][col] || '').trim()
          if (!cell) continue
          total += 1
          if (parseFecha(cell, tabYear)) hits += 1
        }
        if (hits < 2) continue
        const ratio = total > 0 ? hits / total : 0
        // ≥30% de celdas parseables (más agresivo que antes)
        if (ratio >= 0.3 && (ratio > bestRatio || (ratio === bestRatio && hits > bestHits))) {
          bestRatio = ratio
          bestHits = hits
          bestCol = col
        }
      }
      if (bestCol >= 0) idxFecha = bestCol
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

      // Fecha: primero intenta la columna detectada. Si falla, escanea
      // TODAS las columnas de esa fila buscando alguna celda que parsee
      // como fecha. Solo cae a tabDate si NINGUNA celda de la fila lo logra.
      let fecha: string | null = null
      if (idxFecha >= 0) {
        const fechaRaw = (row[idxFecha] || '').trim()
        fecha = parseFecha(fechaRaw, tabYear)
      }
      if (!fecha) {
        // Scan de toda la fila
        for (let c = 0; c < row.length; c++) {
          if (c === idxCliente || c === idxQuien || c === idxMonto || c === idxCanal || c === idxEmail) continue
          const cell = (row[c] || '').trim()
          if (!cell) continue
          const parsed = parseFecha(cell, tabYear)
          if (parsed) { fecha = parsed; break }
        }
      }
      if (!fecha) fecha = tabDate

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
    const tipo_cliente = tipoClienteFromAvg(ticket_promedio)
    const tipo_contrato = tipoContratoFromPagos(pagos)
    const estatus = estatusFromUltima(ultima_aparicion, tipo_contrato, now)
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

  // Aplicar info de las hojas "Renovaciones" (antes de los overrides
  // manuales — el override de Supabase manda sobre lo del sheet).
  for (const c of clientes) {
    const r = renovByKey.get(c.key)
    if (!r) continue
    if (r.estatus) c.estatus = r.estatus
    if (r.notas) c.notas = c.notas ? `${c.notas}\n${r.notas}` : r.notas
  }

  // Aplicar overrides editables (Supabase)
  for (const c of clientes) {
    const ov = overrides.get(c.key)
    if (!ov) continue
    c.has_override = true
    if (ov.nombre) c.cliente = ov.nombre
    if (ov.email) c.email = ov.email
    // NO aplicamos override de fecha_inicio — la fecha siempre es la
    // del primer pago real registrado en el sheet. Overrides viejos
    // se ignoran (quedan en la DB pero ya no se usan).
    if (ov.canal) c.canales = [normalizeCanal(ov.canal)]
    c.notas = ov.notas
    c.hidden = ov.hidden === true
    // Overrides manuales de campos derivados
    if (ov.tipo_cliente) c.tipo_cliente = ov.tipo_cliente
    if (ov.tipo_contrato) {
      c.tipo_contrato = ov.tipo_contrato
      // Re-calcular mes_renovacion y estatus según el override de contrato
      c.mes_renovacion = mesRenovacionDe(c.pagos, ov.tipo_contrato)
      c.estatus = estatusFromUltima(c.ultima_aparicion, ov.tipo_contrato)
    }
    // Override directo de estatus (manda sobre el calculado)
    if (ov.estatus) c.estatus = ov.estatus
    if (typeof ov.meses_renovando === 'number') c.meses_renovando = ov.meses_renovando
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
