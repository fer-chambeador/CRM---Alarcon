import { normalizeCanal } from './canales'
import { normalizePresupuesto, type Presupuesto } from './budget'

export type ParsedLead = {
  tipo_evento: 'usuario_nuevo' | 'empresa_creada' | 'suscripcion_nueva' | 'pago_confirmado'
  email: string | null
  nombre: string | null
  empresa: string | null
  telefono: string | null
  puesto: string | null
  canal_adquisicion: string | null
  plan: string | null
  cupon: string | null
  monto: number | null
  presupuesto: Presupuesto | null
}

function extractEmail(text: string): string | null {
  const slackEmail = text.match(/<mailto:([^|>]+)\|[^>]+>/)
  if (slackEmail) return slackEmail[1].toLowerCase().trim()
  const plain = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)
  if (plain) return plain[0].toLowerCase().trim()
  return null
}

function extractName(text: string): string | null {
  const match = text.match(/Suscripci[oó]n nueva:\s*([^<\n]+?)\s*<mailto:/)
  if (match) {
    const name = match[1].trim()
    if (name.includes('@')) return null
    return name || null
  }
  return null
}

function parseMonto(text: string): number | null {
  // Formato: $1,160.00 MXN o $1160.00 MXN
  const match = text.match(/Monto:\s*\$([0-9,]+\.?\d*)\s*MXN/)
  if (!match) return null
  const num = parseFloat(match[1].replace(/,/g, ''))
  return isNaN(num) ? null : num
}

export function parseSlackMessage(text: string): ParsedLead | null {
  if (!text) return null
  const normalized = text.trim()

  // ── Pago confirmado ─────────────────────────────────
  if (normalized.toLowerCase().includes('pago de suscripci') && normalized.toLowerCase().includes('confirmado')) {
    const email = extractEmail(normalized)
    if (!email) return null

    const monto = parseMonto(normalized)
    // Ignorar si monto es 0 (cupón del 100%)
    if (monto === null || monto === 0) return null

    const nombreMatch = normalized.match(/Usuario:\s*([^(\n<]+?)[\s(<]/)
    const nombre = nombreMatch?.[1]?.trim() || null
    const plan = normalized.match(/Plan:\s*(.+)/)?.[1]?.trim() || null

    return { tipo_evento: 'pago_confirmado', email, nombre, empresa: null, telefono: null, puesto: null, canal_adquisicion: null, plan, cupon: null, monto, presupuesto: null }
  }

  // ── Usuario nuevo ────────────────────────────────────
  if (normalized.startsWith('Usuario nuevo:')) {
    const email = extractEmail(normalized)
    if (!email) return null
    return { tipo_evento: 'usuario_nuevo', email, nombre: null, empresa: null, telefono: null, puesto: null, canal_adquisicion: null, plan: null, cupon: null, monto: null, presupuesto: null }
  }

  // ── Compañia creada ──────────────────────────────────
  if (normalized.toLowerCase().includes('compa') && normalized.toLowerCase().includes('creada')) {
    const email = extractEmail(normalized)
    if (!email) return null
    const telefono = normalized.match(/Tel[eé]fono:\s*(.+)/)?.[1]?.trim() || null
    const puesto = normalized.match(/Rol en la empresa:\s*(.+)/)?.[1]?.trim() || null
    const canalRaw = normalized.match(/Canal de adquisici[oó]n:\s*(.+)/)?.[1]?.trim() || null
    const canal = normalizeCanal(canalRaw)
    const empresa = normalized.match(/Nombre de la empresa:\s*(.+)/)?.[1]?.trim() || null
    const presupuestoRaw = normalized.match(/Presupuesto de reclutamiento:\s*(.+)/)?.[1]?.trim() || null
    const presupuesto = normalizePresupuesto(presupuestoRaw)
    if (puesto && puesto.toLowerCase().includes('soy candidato')) return null
    return { tipo_evento: 'empresa_creada', email, nombre: null, empresa, telefono, puesto, canal_adquisicion: canal, plan: null, cupon: null, monto: null, presupuesto }
  }

  // ── Suscripción nueva ────────────────────────────────
  if (normalized.toLowerCase().includes('suscripci')) {
    const email = extractEmail(normalized)
    if (!email) return null
    const nombre = extractName(normalized)
    const plan = normalized.match(/Plan:\s*(.+)/)?.[1]?.trim() || null
    const cupon = normalized.match(/Cup[oó]n:\s*(.+)/)?.[1]?.trim() || null
    return { tipo_evento: 'suscripcion_nueva', email, nombre, empresa: null, telefono: null, puesto: null, canal_adquisicion: null, plan, cupon, monto: null, presupuesto: null }
  }

  return null
}
