import { NextRequest, NextResponse } from 'next/server'
import { parseCsv } from '@/lib/recurrentes'

export const dynamic = 'force-dynamic'

const DEFAULT_SHEET_ID = '1rzLd59jFMvJgFbDYyaTTnYhOTLYHbeIm8xGx-6btLm4'

/**
 * GET /api/recurrentes/debug?tab=Mayo%202026
 *
 * Devuelve las primeras 6 filas crudas + headers del tab pedido. Útil
 * para diagnosticar por qué las fechas se están leyendo mal.
 *
 * También intenta parsear como fecha cada celda y devuelve qué pasa.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const tab = url.searchParams.get('tab') || 'Mayo 2026'
  const sheetId = process.env.RECURRENTES_SHEET_ID || DEFAULT_SHEET_ID

  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`

  let csv: string | null = null
  try {
    const res = await fetch(csvUrl, { cache: 'no-store', redirect: 'follow' })
    if (!res.ok) {
      return NextResponse.json({ error: `fetch failed: ${res.status}` }, { status: 500 })
    }
    csv = await res.text()
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'fetch error' }, { status: 500 })
  }

  if (!csv || csv.startsWith('<')) {
    return NextResponse.json({ error: 'sheet inaccesible o tab no existe', tab }, { status: 404 })
  }

  // BOM y caracteres invisibles del primer chars
  const firstChars = Array.from(csv.slice(0, 20)).map(c => ({
    char: c,
    code: c.charCodeAt(0),
    hex: c.charCodeAt(0).toString(16),
  }))

  const rows = parseCsv(csv)
  const headers = rows[0] || []
  const sampleRows = rows.slice(1, 7)  // 6 filas de muestra

  // Inspecciona cada celda del header
  const headerInspection = headers.map((h, i) => ({
    idx: i,
    raw: h,
    raw_length: h.length,
    char_codes: Array.from(h.slice(0, 10)).map(c => c.charCodeAt(0)),
    normalized: h.toLowerCase().trim(),
  }))

  return NextResponse.json({
    tab,
    csv_length: csv.length,
    csv_first_chars: firstChars,
    total_rows: rows.length,
    headers_inspection: headerInspection,
    sample_rows_raw: sampleRows.map(r => r.slice(0, Math.min(r.length, 10))),
  })
}
