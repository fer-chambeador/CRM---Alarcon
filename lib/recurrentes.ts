/**
 * Live-feed de clientes recurrentes desde Google Sheets.
 *
 * Fuente: spreadsheet con una tab por mes ("Noviembre 2025", "Diciembre 2025",
 * "Enero 2026", ...). Cada fila es un pago. Filtramos por QUIÉN = Fer.
 *
 * Cero impacto en el resto del CRM: no toca tabla `leads`, no afecta
 * scoring, alertas, ni métricas del dashboard. Solo lee.
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

// Genera la lista de tabs (Noviembre 2025 → mes actual). Self-extending.
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

// Parser CSV simple — maneja campos quoted con comas y "" como escape.
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

// Limpia un monto tipo "$1,160.00 MXN" → 1160
function parseMonto(raw: string): number {
  if (!raw) return 0
  const digits = raw.replace(/[^0-9.,-]/g, '').replace(/,/g, '')
  const n = parseFloat(digits)
  return isNaN(n) ? 0 : n
}

// Limpia una fecha — intenta varios formatos comunes
function parseFecha(raw: string): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  // ISO YYYY-MM-DD
  let m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`
  // DD/MM/YYYY o DD-MM-YYYY
  m = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
  if (m) {
    let y = m[3]
    if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y
    return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`
  }
  // Intento Date.parse como fallback
  const t = Date.parse(trimmed)
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10)
  return null
}

export type ClienteRecurrente = {
  key: string
  cliente: string
  email: string | null
  fecha_inicio: string | null
  total_pagado: number
  veces: number
  canales: string[]
  meses: string[]
}

type FetchOpts = { sheetId?: string; signal?: AbortSignal }

async function fetchTabCsv(sheetId: string, tab: string, signal?: AbortSignal): Promise<string | null> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`
  try {
    const res = await fetch(url, { signal, cache: 'no-store', redirect: 'follow' })
    if (!res.ok) return null
    const text = await res.text()
    // Google devuelve HTML de error como 200 a veces; detectamos.
    if (text.startsWith('<')) return null
    return text
  } catch {
    return null
  }
}

export async function fetchRecurrentes(opts: FetchOpts = {}): Promise<{
  clientes: ClienteRecurrente[]
  meses_leidos: string[]
  meses_intentados: string[]
  total_pagado_global: number
  generated_at: string
}> {
  const sheetId = opts.sheetId || process.env.RECURRENTES_SHEET_ID || DEFAULT_SHEET_ID
  const months = monthsToFetch()
  const intentados = months.map(m => m.name)

  const results = await Promise.all(
    months.map(async m => ({ name: m.name, csv: await fetchTabCsv(sheetId, m.tab, opts.signal) }))
  )

  const map = new Map<string, ClienteRecurrente>()
  const mesesLeidos: string[] = []

  for (const { name, csv } of results) {
    if (!csv) continue
    const rows = parseCsv(csv)
    if (rows.length < 2) continue

    const headers = rows[0]
    const idxQuien = findCol(headers, ['quien', 'responsable', 'vendedor', 'owner', 'coach'])
    const idxCliente = findCol(headers, ['cliente', 'empresa', 'nombre', 'cuenta', 'company'])
    const idxEmail = findCol(headers, ['email', 'correo', 'mail'])
    const idxFecha = findCol(headers, ['fecha', 'date', 'día', 'dia'])
    const idxMonto = findCol(headers, ['monto', 'importe', 'total', 'cantidad', 'amount', 'precio', 'pago'])
    const idxCanal = findCol(headers, ['canal', 'metodo', 'forma', 'via'])

    if (idxQuien < 0) continue
    mesesLeidos.push(name)

    for (const row of rows.slice(1)) {
      const quien = (row[idxQuien] || '').trim()
      if (!norm(quien).includes('fer')) continue

      const cliente = idxCliente >= 0 ? (row[idxCliente] || '').trim() : ''
      const emailRaw = idxEmail >= 0 ? (row[idxEmail] || '').trim() : ''
      const email = emailRaw.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] || null
      const fecha = idxFecha >= 0 ? parseFecha(row[idxFecha] || '') : null
      const monto = idxMonto >= 0 ? parseMonto(row[idxMonto] || '') : 0
      const canal = idxCanal >= 0 ? (row[idxCanal] || '').trim() : ''

      // Si el cliente no tiene nombre ni email, ignoramos la fila
      if (!cliente && !email) continue

      const key = (email || cliente).toLowerCase()
      const existing = map.get(key)
      if (existing) {
        existing.total_pagado += monto
        existing.veces += 1
        if (fecha && (!existing.fecha_inicio || fecha < existing.fecha_inicio)) existing.fecha_inicio = fecha
        if (canal && !existing.canales.includes(canal)) existing.canales.push(canal)
        if (!existing.meses.includes(name)) existing.meses.push(name)
        // Preferimos un nombre legible si lo encontramos después
        if (!existing.cliente && cliente) existing.cliente = cliente
        if (!existing.email && email) existing.email = email
      } else {
        map.set(key, {
          key,
          cliente: cliente || email || '—',
          email,
          fecha_inicio: fecha,
          total_pagado: monto,
          veces: 1,
          canales: canal ? [canal] : [],
          meses: [name],
        })
      }
    }
  }

  const clientes = Array.from(map.values()).sort((a, b) => b.total_pagado - a.total_pagado)
  const total_pagado_global = clientes.reduce((s, c) => s + c.total_pagado, 0)

  return {
    clientes,
    meses_leidos: mesesLeidos,
    meses_intentados: intentados,
    total_pagado_global,
    generated_at: new Date().toISOString(),
  }
}
