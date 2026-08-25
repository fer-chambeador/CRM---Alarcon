// Revenue real del mes desde el Google Sheet 'Revenue' (fuente de verdad de Fer).
// La card 'Pipeline cerrado' del CRM muestra este numero cuando esta disponible;
// si el fetch falla, la card cae al calculo interno por leads convertidos.
// Pestanas por mes: 'Agosto 2026', 'Septiembre 2026', etc. Columna K = REVENUE.
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SHEET_ID = '1rzLd59jFMvJgFbDYyaTTnYhOTLYHbeIm8xGx-6btLm4'
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

function parseMoney(s: string): number | null {
  const m = s.replace(/[^0-9.]/g, '')
  if (!m) return null
  const n = parseFloat(m)
  return isNaN(n) ? null : n
}

export async function GET() {
  // Mes actual en horario CDMX
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }))
  const sheetName = MESES[now.getMonth()] + ' ' + now.getFullYear()
  const url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(sheetName)
  try {
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) return NextResponse.json({ ok: false, error: 'fetch ' + r.status }, { status: 502 })
    const csv = await r.text()
    const lines = csv.split('\n')
    const parseRow = (line: string) => line.split('","').map(s => s.replace(/^"|"$/g, '').trim())
    const header = parseRow(lines[0] || '')
    const revIdx = header.findIndex(h => h.toUpperCase() === 'REVENUE')
    const montoIdx = header.findIndex(h => h.toUpperCase() === 'MONTO')
    let revenue: number | null = null
    let deals = 0
    for (let i = 1; i < lines.length; i++) {
      const cols = parseRow(lines[i])
      if (revenue === null && revIdx >= 0 && cols[revIdx]) revenue = parseMoney(cols[revIdx])
      if (montoIdx >= 0 && cols[montoIdx] && parseMoney(cols[montoIdx])) deals++
    }
    if (revenue === null) return NextResponse.json({ ok: false, error: 'REVENUE no encontrado en ' + sheetName }, { status: 500 })
    return NextResponse.json({ ok: true, revenue, deals, sheet: sheetName })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e).slice(0, 200) }, { status: 500 })
  }
}
