// Clientes grandes (Fer, 7-oct-2026): agrega pagos del Google Sheet 'Revenue'
// (pestañas 'Enero 2026' … mes actual) por cliente y regresa los que suman
// más de $5,000. Fuente de verdad del dinero = el sheet; lo editable vive en
// la tabla clientes_grandes (ver sql/migrations/2026-10-07-clientes-grandes.sql).

const SHEET_ID = '1rzLd59jFMvJgFbDYyaTTnYhOTLYHbeIm8xGx-6btLm4'
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
export const UMBRAL_CLIENTE_GRANDE = 5000

export type ClienteSheet = {
  key: string            // email en minúsculas
  cliente: string        // como viene en el sheet
  total: number
  pagos: number
  vacantes: number
  primer_pago: string | null  // ISO yyyy-mm-dd
  ultimo_pago: string | null
  canal: string | null        // CANAL del último pago (Moy, Rodrigo, ChambasAI, Inbound…)
  metodo: string | null
}

/** CSV parser mínimo con comillas (el gviz devuelve todo entre comillas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cur); rows.push(row); row = []; cur = ''
    } else cur += c
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows
}

function money(s: string): number {
  const n = parseFloat((s || '').replace(/[^0-9.\-]/g, ''))
  return isNaN(n) ? 0 : n
}

/** 'dd/mm/yy' o 'dd/mm/yyyy' → 'yyyy-mm-dd' */
function fecha(s: string): string | null {
  const m = (s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (!m) return null
  const y = m[3].length === 2 ? '20' + m[3] : m[3]
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

export function mesesDesdeEnero(now = new Date()): string[] {
  const mx = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }))
  const out: string[] = []
  for (let m = 0; m <= mx.getMonth(); m++) out.push(`${MESES[m]} ${mx.getFullYear()}`)
  return out
}

export async function fetchClientesDelSheet(): Promise<{ clientes: ClienteSheet[]; pestañas: string[]; errores: string[] }> {
  const pestañas = mesesDesdeEnero()
  const errores: string[] = []
  const agg = new Map<string, ClienteSheet>()
  await Promise.all(pestañas.map(async sheet => {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`
    try {
      const r = await fetch(url, { cache: 'no-store' })
      if (!r.ok) { errores.push(`${sheet}: HTTP ${r.status}`); return }
      const rows = parseCsv(await r.text())
      const head = (rows[0] || []).map(h => h.trim().toUpperCase())
      const iCli = head.indexOf('CLIENTE'), iMonto = head.indexOf('MONTO'), iFecha = head.indexOf('FECHA')
      const iVac = head.indexOf('# DE VACANTES'), iCanal = head.indexOf('CANAL'), iMet = head.findIndex(h => h.startsWith('MÉTODO') || h.startsWith('METODO'))
      if (iCli < 0 || iMonto < 0) { errores.push(`${sheet}: sin columnas CLIENTE/MONTO`); return }
      for (const row of rows.slice(1)) {
        const cliente = (row[iCli] || '').trim()
        const monto = money(row[iMonto] || '')
        if (!cliente || monto <= 0) continue
        const key = cliente.toLowerCase()
        const f = iFecha >= 0 ? fecha(row[iFecha] || '') : null
        const cur = agg.get(key) || { key, cliente, total: 0, pagos: 0, vacantes: 0, primer_pago: null, ultimo_pago: null, canal: null, metodo: null }
        cur.total += monto
        cur.pagos += 1
        cur.vacantes += iVac >= 0 ? (parseInt(row[iVac] || '0', 10) || 0) : 0
        if (f && (!cur.primer_pago || f < cur.primer_pago)) cur.primer_pago = f
        if (f && (!cur.ultimo_pago || f >= cur.ultimo_pago)) {
          cur.ultimo_pago = f
          cur.canal = iCanal >= 0 ? (row[iCanal] || '').trim() || cur.canal : cur.canal
          cur.metodo = iMet >= 0 ? (row[iMet] || '').trim() || cur.metodo : cur.metodo
        }
        agg.set(key, cur)
      }
    } catch (e) {
      errores.push(`${sheet}: ${String(e).slice(0, 120)}`)
    }
  }))
  const clientes = [...agg.values()].filter(c => c.total > UMBRAL_CLIENTE_GRANDE)
  return { clientes, pestañas, errores }
}

/** CANAL del sheet → owner sugerido. */
export function ownerDesdeCanal(canal: string | null): string {
  const c = (canal || '').toLowerCase()
  if (c.includes('moy') || c.includes('mois')) return 'Moisés'
  if (c.includes('rodrigo')) return 'Rodrigo'
  if (c.includes('fer')) return 'Fer'
  return 'Sin asignar'
}

export const OWNERS = ['Sin asignar', 'Moisés', 'Fer', 'Rodrigo', 'Marina'] as const

/** Salud según días desde el último pago. */
export function saludPorPago(ultimo: string | null): 'activo' | 'seguimiento' | 'riesgo' {
  if (!ultimo) return 'riesgo'
  const dias = (Date.now() - new Date(ultimo + 'T12:00:00-06:00').getTime()) / 86_400_000
  if (dias <= 35) return 'activo'
  if (dias <= 60) return 'seguimiento'
  return 'riesgo'
}
