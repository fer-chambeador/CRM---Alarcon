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
  vacante: string | null
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

    return { tipo_evento: 'pago_confirmado', email, nombre, empresa: null, telefono: null, puesto: null, canal_adquisicion: null, plan, cupon: null, monto, presupuesto: null, vacante: null }
  }

  // ── Usuario nuevo ────────────────────────────────────
  if (normalized.startsWith('Usuario nuevo:')) {
    const email = extractEmail(normalized)
    if (!email) return null
    return { tipo_evento: 'usuario_nuevo', email, nombre: null, empresa: null, telefono: null, puesto: null, canal_adquisicion: null, plan: null, cupon: null, monto: null, presupuesto: null, vacante: null }
  }

  // ── Compañia creada ──────────────────────────────────
  if (normalized.toLowerCase().includes('compa') && normalized.toLowerCase().includes('creada')) {
    const email = extractEmail(normalized)
    if (!email) return null
    // BUG FIX (15-jun-2026): el mensaje de #canirac llega TODO en una línea
    // sin newlines (campos separados por múltiples espacios). Los regex
    // `(.+)` greedy se tragaban todo el resto del texto incluyendo los
    // siguientes campos. Insertamos `\n` antes de cada label conocido para
    // que `(.+)` se detenga en el siguiente campo.
    const LABELS = [
      'Usuario', 'Tel[eé]fono', 'Rol en la empresa', 'Canal de adquisici[oó]n',
      'Nombre de la empresa', 'Puesto', 'Presupuesto de reclutamiento',
    ]
    let preprocessed = normalized
    for (const label of LABELS) {
      preprocessed = preprocessed.replace(new RegExp(`(\\s|^)(${label})\\s*:`, 'g'), `\n$2:`)
    }
    const telefono = preprocessed.match(/Tel[eé]fono:\s*([^\n]+)/)?.[1]?.trim() || null
    const puesto = preprocessed.match(/Rol en la empresa:\s*([^\n]+)/)?.[1]?.trim() || null
    const canalRaw = preprocessed.match(/Canal de adquisici[oó]n:\s*([^\n]+)/)?.[1]?.trim() || null
    const canal = normalizeCanal(canalRaw)
    const empresa = preprocessed.match(/Nombre de la empresa:\s*([^\n]+)/)?.[1]?.trim() || null
    const presupuestoRaw = preprocessed.match(/Presupuesto de reclutamiento:\s*([^\n]+)/)?.[1]?.trim() || null
    const presupuesto = normalizePresupuesto(presupuestoRaw)
    // "Puesto:" = vacante que el cliente quiere reclutar (NO confundir con "Rol en la empresa")
    const vacanteMatch = preprocessed.match(/Puesto:\s*([^\n]+)/)
    const vacante = vacanteMatch?.[1]?.trim() || null
    // ── Filtro candidatos (NO son leads B2B, no deben entrar al CRM) ──
    // Cuando "Rol en la empresa" es "busco trabajo", "soy candidato",
    // "busco empleo", "necesito trabajo", etc. son personas buscando chamba
    // que llegaron por error al canal de empresas. Descartar en el parser
    // hace que el webhook de Slack retorne { ok: true } sin insertar nada.
    if (puesto) {
      const p = puesto.toLowerCase()
      const CANDIDATE_KEYWORDS = [
        'soy candidato',
        'busco trabajo',
        'buscando trabajo',
        'busco empleo',
        'buscando empleo',
        'necesito trabajo',
        'necesito empleo',
        'quiero trabajar',
        'quiero un trabajo',
        'estoy buscando',
        'aplicar a un puesto',
        'aplicar al puesto',
        'me interesa el puesto',
        'oferta de trabajo',
      ]
      if (CANDIDATE_KEYWORDS.some(k => p.includes(k))) return null
    }
    // ── Filtro candidatos v2 (8-jul-2026, caso gabrielargenisa) ──────────
    // Los candidatos no siempre dicen "busco trabajo" — se detectan por
    // COMBINACIÓN de señales: empresa basura ("Nose", "ninguna", "x"),
    // rol de trabajador ("Ayudante", "atendió personas", "empleado") y
    // presupuesto vacío/none. Se requieren 2+ señales para descartar, así
    // un empleador real con un campo mal llenado sigue entrando.
    {
      const norm = (s: string | null) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
      const emp = norm(empresa)
      const rol = norm(puesto)
      const JUNK_EMPRESA = ['nose', 'no se', 'nose.', 'no c', 'ninguna', 'ninguno', 'no tengo', 'na', 'n/a', 'x', 'xx', 'xxx', '.', '-', 'no', 'nada', 'prueba', 'test', 'particular', 'personal', 'yo', 'hogar', 'casa', 'aun no', 'todavia no', 'pendiente', 'sin nombre', 'sin empresa', 'no aplica']
      const WORKER_ROL = ['ayudante', 'atendio personas', 'atendi personas', 'empleado', 'empleada', 'operario', 'obrero', 'trabajador', 'candidato', 'desempleado', 'sin trabajo', 'busco', 'chalan', 'ayudante general', 'auxiliar general']
      const empresaJunk = !emp || emp.length <= 2 || JUNK_EMPRESA.includes(emp)
      const rolTrabajador = WORKER_ROL.some(k => rol.includes(k))
      const sinPresupuesto = presupuesto === null || presupuestoRaw === null || ['none', 'no', 'nada', '0', 'ninguno'].includes(norm(presupuestoRaw))
      const señales = (empresaJunk ? 1 : 0) + (rolTrabajador ? 1 : 0) + (sinPresupuesto ? 1 : 0)
      if (rolTrabajador && señales >= 2) return null
      if (empresaJunk && sinPresupuesto && !rol) return null
    }
    return { tipo_evento: 'empresa_creada', email, nombre: null, empresa, telefono, puesto, canal_adquisicion: canal, plan: null, cupon: null, monto: null, presupuesto, vacante }
  }

  // ── Suscripción nueva ────────────────────────────────
  if (normalized.toLowerCase().includes('suscripci')) {
    const email = extractEmail(normalized)
    if (!email) return null
    const nombre = extractName(normalized)
    const plan = normalized.match(/Plan:\s*(.+)/)?.[1]?.trim() || null
    const cupon = normalized.match(/Cup[oó]n:\s*(.+)/)?.[1]?.trim() || null
    return { tipo_evento: 'suscripcion_nueva', email, nombre, empresa: null, telefono: null, puesto: null, canal_adquisicion: null, plan, cupon, monto: null, presupuesto: null, vacante: null }
  }

  return null
}
