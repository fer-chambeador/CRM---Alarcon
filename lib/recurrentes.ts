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
  total_pagado: number
  veces: number
  canales: string[]
  meses: string[]
  notas: string | null
  has_override: boolean
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
}

async function fetchOverrides(): Promise<Map<string, Override>> {
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('clientes_recurrentes_meta')
      .select('key,nombre,email,fecha_inicio,canal,notas')
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

    if (idxQuien < 0) continue
    mesesLeidos.push(name)

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

      if (!cleanName && !email) continue

      // Key estable — email preferido, sino nombre normalizado
      const key = (email ? email.toLowerCase() : norm(cleanName))
      const existing = map.get(key)
      if (existing) {
        existing.total_pagado += monto
        existing.veces += 1
        if (tabDate && (!existing.fecha_inicio || tabDate < existing.fecha_inicio)) {
          existing.fecha_inicio = tabDate
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
          fecha_inicio: tabDate,
          total_pagado: monto,
          veces: 1,
          canales: canal ? [canal] : [],
          meses: [name],
          notas: null,
          has_override: false,
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
