/**
 * Helpers de export a CSV/Excel.
 *
 * Generamos CSV con BOM UTF-8 para que Excel respete los acentos al
 * abrir el archivo. CSV es el formato más simple que Excel entiende
 * nativamente (doble-click → se abre en Excel).
 */

/** Escapa una celda según RFC 4180: si tiene coma, comillas o saltos, va entre comillas. */
function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/** Convierte filas + headers en un string CSV con BOM UTF-8. */
export function rowsToCsv(headers: string[], rows: unknown[][]): string {
  const BOM = '﻿'
  const head = headers.map(escapeCell).join(',')
  const body = rows.map(r => r.map(escapeCell).join(',')).join('\n')
  return BOM + head + '\n' + body + '\n'
}

/** Dispara la descarga del CSV en el navegador. */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 500)
}

/** Slug para nombre de archivo: "Leads - 25 may 2026.csv" */
export function exportFilename(prefix: string, ext = 'csv'): string {
  const d = new Date()
  const fecha = d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
    .replace(/\./g, '').replace(/\s+/g, '-')
  return `${prefix}-${fecha}.${ext}`
}
