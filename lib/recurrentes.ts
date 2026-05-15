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

export type ClienteRecurrente = {
  key: string
  cliente: string
  email: string | null
  fecha_inicio: string | null
  ultima_aparicion: string | null
  total_pagado: number
  veces: number
  canales: string[]
  meses: string[]
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

  const map = new Map<string, ClienteRecurrente>()
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
    const idxFecha = findCol(headers, ['fecha', 'date', 'dia', 'día'])

    if (idxQuien < 0) continue
    mesesLeidos.push(name)

    // Año del tab — para resolver fechas que vienen sin año en la celda.
    const tabYear = tabDate ? parseInt(tabDate.slice(0, 4), 10) : undefined

    for (const row of rows.slice(1)) {
      const quien = (row[idxQuien] || '').trim()
      if (!norm(quien).includes('fer')) continue

      const clienteRaw = idxCliente >= 0 ? (row[idxCliente] || '').trim() : ''
      const emailFromCol = idxEmail >= 0
        ? (row[idxEmail] || '').match(EMAIL_RE)?.[0] || null
        : null
      const { name: cleanName, email: emailFromName } = splitNameEmail(clienteRaw)
      const email = emailFromCol || emailFromName
      const monto = idxMonto >= 0 ? parseMonto(row[idxMonto] || '') : 0
      const canal = idxCanal >= 0 ? (row[idxCanal] || '').trim() : ''
      const fechaRaw = idxFecha >= 0 ? (row[idxFecha] || '').trim() : ''
      // Día EXACTO del pago: de la columna fecha, con fallback al día 1 del tab.
      const rowDate = parseFecha(fechaRaw, tabYear) || tabDate

      if (!cleanName && !email) continue

      // Key estable — email preferido, sino nombre normalizado
      const key = (email ? email.toLowerCase() : norm(cleanName))
      const existing = map.get(key)
      if (existing) {
        existing.total_pagado += monto
        existing.veces += 1
        if (rowDate && (!existing.fecha_inicio || rowDate < existing.fecha_inicio)) {
          existing.fecha_inicio = rowDate
        }
        if (rowDate && (!existing.ultima_aparicion || rowDate > existing.ultima_aparicion)) {
          existing.ultima_aparicion = rowDate
        }
        if (canal && !existing.canales.includes(canal)) existing.canales.push(canal)
        if (!existing.meses.includes(name)) existing.meses.push(name)
        if (!existing.email && email) existing.email = email
        if ((!existing.cliente || existing.cliente === existing.email) && cleanName && cleanName !== email) {
          existing.cliente = cleanName
        }
      } else {
        map.set(key, {
          key,
          cliente: cleanName || email || '—',
          email,
          fecha_inicio: rowDate,
          ultima_aparicion: rowDate,
          total_pagado: monto,
          veces: 1,
          canales: canal ? [canal] : [],
          meses: [name],
          notas: null,
          has_override: false,
          hidden: false,
        })
      }
    }
  }

  // Aplicar overrides editables
  for (const c of Array.from(map.values())) {
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

  const clientes = Array.from(map.values()).sort((a, b) => b.total_pagado - a.total_pagado)
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
