/**
 * Normalización de datos crudos de Vambe → categorías limpias del CRM.
 *
 * Usado por:
 *  - app/api/vambe/webhook/route.ts (promotePendingLead) → leads que entran por webhook
 *  - app/api/vambe/backfill/route.ts (processContact) → leads históricos
 */

// ─── Empresa desde correo corporativo ───────────────────────────────────

/**
 * Proveedores gratuitos comunes — emails con estos dominios NO son corporativos.
 */
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'hotmail.com', 'hotmail.es', 'hotmail.com.mx', 'hotmail.mx',
  'outlook.com', 'outlook.es', 'outlook.com.mx',
  'live.com', 'live.com.mx',
  'yahoo.com', 'yahoo.com.mx', 'yahoo.es',
  'icloud.com', 'me.com', 'mac.com',
  'msn.com', 'aol.com',
  'protonmail.com', 'proton.me', 'tutanota.com',
  'mail.com', 'ymail.com', 'rocketmail.com',
  'gmx.com', 'gmx.es',
  'zoho.com',
])

/**
 * Si el email es corporativo, devuelve un nombre razonable de empresa
 * tomado del primer segmento del dominio. Si es gmail/hotmail/etc → null.
 *
 * Ejemplos:
 *   'rrhh@gabin.com.mx'      → 'Gabin'
 *   'ana@my-company.io'      → 'My Company'
 *   'foo@gmail.com'          → null
 *   'x@grupo_vallemex.com'   → 'Grupo Vallemex'
 */
export function extractCompanyFromEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const lower = email.toLowerCase().trim()
  const at = lower.indexOf('@')
  if (at < 0) return null
  const domain = lower.slice(at + 1)
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return null

  // Tomar el primer segmento del dominio (gabin.com.mx → gabin)
  const firstSegment = domain.split('.')[0]
  if (!firstSegment) return null

  // Limpiar: reemplazar - y _ por espacio, capitalizar cada palabra
  return firstSegment
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// ─── Puesto / rol del lead (situación actual) ──────────────────────────

/**
 * Mapea la respuesta libre del form "¿cuál describe mejor tu situación actual?"
 * a una de 4 categorías limpias.
 *
 * Ejemplos:
 *   'Recluto o gestiono personal (RH, operaciones, dueño de negocio)' → 'Reclutador / RH'
 *   'Soy dueño de mi negocio'                                          → 'Dueño / Empresario'
 *   'Soy gerente del área de operaciones'                              → 'Gerente / Director'
 *   ''                                                                  → null
 */
export function normalizePuesto(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.toLowerCase()
  if (!t.trim()) return null

  // Orden importa — más específico primero
  if (/reclut|rh\b|recursos humanos|gestiono personal|recluto/.test(t)) return 'Reclutador / RH'
  if (/dueñ|propietari|fundador|founder|owner|empresari|emprendedor|soy due/.test(t)) return 'Dueño / Empresario'
  if (/gerent|director|jefe|líder|supervisor|coordinador|manager|head/.test(t)) return 'Gerente / Director'
  if (/operaciones|operativo/.test(t)) return 'Reclutador / RH'   // "operaciones" suele venir con RH

  return 'Otro'
}

// ─── Vacante (puesto que el cliente quiere reclutar) ───────────────────

/**
 * Lista canónica derivada de las vacantes existentes en el CRM.
 * Cada categoría tiene una lista de patrones que la disparan.
 * El orden importa: más específico arriba.
 */
const VACANTE_RULES: Array<{ label: string; patterns: RegExp[] }> = [
  // Cocina y restaurante (antes de "Ayudante general" porque "ayudante de cocina" matchea cocinero)
  { label: 'Cocinero', patterns: [/cociner/, /\bcocina\b/, /\bchef\b/, /ayudante de cocina/, /\bparrilla/, /pizzero/] },
  { label: 'Mesero', patterns: [/\bmesero/, /\bmesera/, /\bcamarer/] },
  { label: 'Garrotero', patterns: [/garroter/] },
  { label: 'Hostess', patterns: [/\bhostess/, /\banfitrion/] },
  { label: 'Lavaloza', patterns: [/lavalo[zs]a/, /\blavaplatos/] },
  { label: 'Taquero', patterns: [/\btaquero/, /\btaquera/] },
  { label: 'Barista', patterns: [/\bbarista/] },

  // Seguridad
  { label: 'Seguridad', patterns: [/\bguardia/, /seguridad/, /vigilan/, /custodi/, /intramuros/] },

  // Limpieza
  { label: 'Limpieza', patterns: [/limpiez/, /\bintendenc/, /\baseo\b/, /\bmucam/, /housekeep/] },

  // Choferes / Repartidores
  { label: 'Chofer', patterns: [/\bchofer/, /\bconductor/, /\boperador\s+de\s+(camion|trailer|tractocami)/, /motorista/] },
  { label: 'Repartidor', patterns: [/repartid/, /\bdelivery/, /\bmotorizado/, /\bmensajer/, /entrega/] },

  // Almacén y operación industrial
  { label: 'Almacenista', patterns: [/almacenist/, /\balmacén\b/, /\balmacen\b/, /bodeguer/, /montacarguist/, /\bsurtidor/] },
  { label: 'Operador Industrial', patterns: [/operador industrial/, /operario industrial/, /operador de máquin/, /operador de maquin/, /\bobrero/] },

  // Mantenimiento y oficios
  { label: 'Mantenimiento', patterns: [/mantenimient/, /electricis/, /plomer/, /alban|albañil/, /\bherrer/, /carpinter/, /\bsoldador/, /pintor\b/] },
  { label: 'Mecánico', patterns: [/mec[áa]nic/, /hojalater/] },

  // Comercial
  { label: 'Ventas', patterns: [/\bventas?\b/, /\bvendedor/, /\bvendedora/, /comercial/, /asesor\s+(comercial|de venta)/, /ejecutivo de venta/, /ejecutivos comerciales/, /promot/, /impulsador/] },
  { label: 'Cajero', patterns: [/\bcajer/] },
  { label: 'Call Center', patterns: [/call ?center/, /\bcallcenter/, /telemark/, /telefonist/] },
  { label: 'Gestor de Cobranza', patterns: [/cobran[zs]a/, /\bgestor de/] },

  // Administrativos / oficina
  { label: 'Recepcionista', patterns: [/recepcionis/, /\brecepción\b/, /\brecepcion\b/] },
  { label: 'Auxiliar Administrativo', patterns: [/auxiliar admin/, /asistent/, /secretari/, /oficinist/, /administrativ/] },
  { label: 'Contador', patterns: [/contador/, /contabil/] },

  // Especializados
  { label: 'Enfermería', patterns: [/enfermer/, /\bparamedic/, /paramédic/] },
  { label: 'Técnico', patterns: [/t[ée]cnico/] },
  { label: 'Reclutador', patterns: [/reclutad/] },

  // Generales (al final, son catch-all amplios)
  { label: 'Gerente', patterns: [/gerent/, /\bdirector/, /\bjefe/, /\bsuperviso/, /coordinad/, /\bmanager\b/] },
  { label: 'Ayudante general', patterns: [/ayudante[s]?\s+general/, /\bayudant/, /\bauxiliar\b/] },
  { label: 'Operativos', patterns: [/operativ/] },
]

/**
 * Normaliza el texto libre de "¿qué puestos necesitas reclutar?" a una de
 * las categorías canónicas del CRM. Si no matchea ninguna → 'Otro'.
 */
export function normalizeVacante(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // sacar acentos para matching
  if (!t.trim()) return null

  for (const rule of VACANTE_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(t)) return rule.label
    }
  }
  return 'Otro'
}

// ─── Notas con info extra del formulario ───────────────────────────────

/**
 * Construye una string de notas con la info no-estructurada del form de Vambe.
 * Incluye vacantes/mes, inbox_url, y opcionalmente el rol original sin normalizar.
 */
export function buildNotasFromForm(form: {
  vacantes_por_mes?: string
  inbox_url?: string
  rol?: string                   // valor crudo de "situación actual"
} | null | undefined): string | null {
  if (!form) return null
  const lines: string[] = []
  if (form.vacantes_por_mes) lines.push(`Vacantes/mes: ${form.vacantes_por_mes}`)
  if (form.rol) lines.push(`Situación: ${form.rol}`)
  if (form.inbox_url) lines.push(`Inbox Vambe: ${form.inbox_url}`)
  return lines.length ? lines.join('\n') : null
}
