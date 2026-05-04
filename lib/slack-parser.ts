/**
 * Parser de mensajes del bot "Chambas Alert" en #leads-sales
 *
 * Tipos de mensajes:
 * 1. "Usuario nuevo: email@ejemplo.com"
 * 2. "Compañia creada por el usuario\n  Usuario: email...\n  Teléfono: ...\n  Rol: ...\n  Canal: ...\n  Empresa: ..."
 * 3. "Suscripción nueva: Nombre <email>\n  Plan: ...\n  Cupón: ...\n  Porcentaje: ..."
 */

export type ParsedLead = {
  tipo_evento: 'usuario_nuevo' | 'empresa_creada' | 'suscripcion_nueva'
  email: string | null
  nombre: string | null
  empresa: string | null
  telefono: string | null
  puesto: string | null
  canal_adquisicion: string | null
  plan: string | null
  cupon: string | null
}

function extractEmail(text: string): string | null {
  // Formato Slack: <mailto:email@ejemplo.com|email@ejemplo.com>
  const slackEmail = text.match(/<mailto:([^|>]+)\|[^>]+>/)
  if (slackEmail) return slackEmail[1].toLowerCase().trim()

  // Email plano
  const plain = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)
  if (plain) return plain[0].toLowerCase().trim()

  return null
}

function extractName(text: string): string | null {
  // Formato "Suscripción nueva: Nombre Apellido <mailto:...>"
  const match = text.match(/Suscripci[oó]n nueva:\s*([^<\n]+?)\s*<mailto:/)
  if (match) {
    const name = match[1].trim()
    // Si parece un email, ignorar
    if (name.includes('@')) return null
    return name || null
  }
  return null
}

export function parseSlackMessage(text: string): ParsedLead | null {
  if (!text) return null

  const normalized = text.trim()

  // ── 1. Usuario nuevo ────────────────────────────────
  if (normalized.startsWith('Usuario nuevo:')) {
    const email = extractEmail(normalized)
    if (!email) return null
    return {
      tipo_evento: 'usuario_nuevo',
      email,
      nombre: null,
      empresa: null,
      telefono: null,
      puesto: null,
      canal_adquisicion: null,
      plan: null,
      cupon: null,
    }
  }

  // ── 2. Compañia creada ──────────────────────────────
  if (normalized.toLowerCase().includes('compa') && normalized.toLowerCase().includes('creada')) {
    const email = extractEmail(normalized)
    if (!email) return null

    const telefono = normalized.match(/Tel[eé]fono:\s*(.+)/)?.[1]?.trim() || null
    const puesto = normalized.match(/Rol en la empresa:\s*(.+)/)?.[1]?.trim() || null
    const canal = normalized.match(/Canal de adquisici[oó]n:\s*(.+)/)?.[1]?.trim() || null
    const empresa = normalized.match(/Nombre de la empresa:\s*(.+)/)?.[1]?.trim() || null

    return {
      tipo_evento: 'empresa_creada',
      email,
      nombre: null,
      empresa,
      telefono,
      puesto,
      canal_adquisicion: canal,
      plan: null,
      cupon: null,
    }
  }

  // ── 3. Suscripción nueva ────────────────────────────
  if (normalized.toLowerCase().includes('suscripci')) {
    const email = extractEmail(normalized)
    if (!email) return null

    const nombre = extractName(normalized)
    const plan = normalized.match(/Plan:\s*(.+)/)?.[1]?.trim() || null
    const cupon = normalized.match(/Cup[oó]n:\s*(.+)/)?.[1]?.trim() || null

    return {
      tipo_evento: 'suscripcion_nueva',
      email,
      nombre,
      empresa: null,
      telefono: null,
      puesto: null,
      canal_adquisicion: null,
      plan,
      cupon,
    }
  }

  return null
}
