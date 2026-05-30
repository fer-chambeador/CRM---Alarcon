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

  // Tomar el primer segmento (no la TLD): "gabin.com.mx" → "gabin"
  // pero "rh.empresa.com.mx" → "empresa" si el primer segmento es genérico
  const segments = domain.split('.').filter(Boolean)
  if (segments.length === 0) return null

  const GENERIC_SUBDOMAINS = new Set([
    'rh', 'recursos', 'reclutamiento', 'reclutamientos', 'hr', 'people',
    'contacto', 'info', 'mail', 'admin', 'team', 'sales', 'ventas',
    'soporte', 'help', 'support', 'noreply', 'no-reply',
    'recursoshumanos',
  ])

  // Si el primer segmento es genérico y hay otro segmento usable, tomar el siguiente
  let raw = segments[0]
  if (GENERIC_SUBDOMAINS.has(raw) && segments.length > 1) {
    raw = segments[1]
  }

  return formatCompanyName(raw)
}

/**
 * Formatea un slug de dominio a un nombre de empresa legible.
 *  "capital-media"   → "Capital Media"
 *  "capitalmedia"    → "Capital Media"   (split por palabras conocidas)
 *  "grupo_vallemex"  → "Grupo Vallemex"
 *  "delilife"        → "Delilife"        (no se puede splitear, pero igual capital)
 */
export function formatCompanyName(raw: string): string {
  if (!raw) return ''
  // Primero: split por separadores explícitos
  let parts = raw.replace(/[-_+\.]+/g, ' ').split(/\s+/).filter(Boolean)

  // Para cada parte, intentar split por palabras conocidas si está pegado
  parts = parts.flatMap(p => splitConcatenatedWords(p))

  return parts.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/**
 * Intenta separar palabras pegadas como "capitalmedia" → ["capital", "media"].
 * Usa una lista pequeña de palabras frecuentes en nombres corporativos.
 * Si no encuentra splits razonables, devuelve la palabra original.
 */
function splitConcatenatedWords(word: string): string[] {
  if (word.length < 8) return [word]    // muy corto para splitear

  // Palabras frecuentes en nombres de empresa MX
  const COMMON_WORDS = [
    'grupo', 'media', 'capital', 'consult', 'servicios', 'soluciones',
    'global', 'mexico', 'tech', 'tecnolog', 'industrial', 'comercial',
    'corp', 'sistemas', 'logistic', 'transport', 'security', 'health',
    'seguros', 'foods', 'distrib', 'inmobil', 'plaza', 'centro',
    'farma', 'medic', 'auto', 'motors', 'express', 'rapid', 'fast',
    'super', 'mega', 'mini', 'plus', 'pro', 'next', 'best', 'first',
    'rrhh', 'staff', 'team', 'human', 'people',
  ]

  // Buscar la primera palabra común que aparezca como prefijo o sufijo
  const lower = word.toLowerCase()
  for (const w of COMMON_WORDS) {
    if (lower.startsWith(w) && lower.length > w.length + 2) {
      return [w, lower.slice(w.length)]
    }
    if (lower.endsWith(w) && lower.length > w.length + 2) {
      return [lower.slice(0, lower.length - w.length), w]
    }
  }

  return [word]
}

// ─── Puesto / rol del lead (situación actual) ──────────────────────────

/**
 * Mapea la respuesta libre del form "¿cuál describe mejor tu situación actual?"
 * a una de 4 categorías limpias. Labels unificados con los existentes en el CRM
 * (Slack los guardaba en singular sin sufijos).
 *
 * Ejemplos:
 *   'Recluto o gestiono personal (RH, operaciones, dueño de negocio)' → 'Reclutador'
 *   'Soy dueño de mi negocio'                                          → 'Dueño'
 *   'Soy gerente del área de operaciones'                              → 'Gerente'
 *   ''                                                                  → null
 */
export function normalizePuesto(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.toLowerCase()
  if (!t.trim()) return null

  // Orden importa — más específico primero.
  // Labels unificados con los existentes en el CRM (Slack): Reclutador, Dueño, Gerente, etc.
  if (/reclut|rh\b|recursos humanos|gestiono personal|recluto/.test(t)) return 'Reclutador'
  if (/dueñ|propietari|fundador|founder|owner|empresari|emprendedor|soy due/.test(t)) return 'Dueño'
  if (/gerent|director|jefe|líder|supervisor|coordinador|manager|head/.test(t)) return 'Gerente'
  if (/operaciones|operativo/.test(t)) return 'Reclutador'   // "operaciones" suele venir con RH

  return 'Otro'
}

// ─── Vacante (puesto que el cliente quiere reclutar) ───────────────────

/**
 * Lista canónica de categorías de vacante.
 * Derivada de las categorías existentes en el CRM, con consolidación de
 * categorías con poco volumen en categorías más grandes (decisión del producto):
 *
 *   Garrotero, Hostess       → Mesero
 *   Taquero, Lavaloza        → Cocinero
 *   Mecánico                 → Mantenimiento
 *   Gestor de Cobranza       → Call Center
 *   Operativos, Multifuncional → Ayudante general
 *   Promotor                 → Ventas
 *
 * El orden importa: la PRIMERA regla que matchea gana, así que las más
 * específicas (que podrían absorberse en una genérica) van arriba.
 */
const VACANTE_RULES: Array<{ label: string; patterns: RegExp[] }> = [
  // ── Cocina (consolida Taquero + Lavaloza) — antes de "Ayudante general" porque "ayudante de cocina" debe ir acá
  { label: 'Cocinero', patterns: [
    /cociner/, /\bcocina\b/, /\bchef\b/, /ayudante de cocina/,
    /\bparrilla/, /pizzero/,
    /\btaquero/, /\btaquera/,                    // ← Taquero merged
    /lavalo[zs]a/, /\blavaplatos/,               // ← Lavaloza merged
  ] },
  // ── Restaurante front-of-house (consolida Garrotero + Hostess)
  { label: 'Mesero', patterns: [
    /\bmesero/, /\bmesera/, /\bcamarer/,
    /garroter/,                                  // ← Garrotero merged
    /\bhostess/, /\banfitrion/,                  // ← Hostess merged
    /\bbarista/,                                 // ← Barista absorbido también
  ] },

  // ── Seguridad
  { label: 'Seguridad', patterns: [/\bguardia/, /seguridad/, /vigilan/, /custodi/, /intramuros/] },

  // ── Limpieza
  { label: 'Limpieza', patterns: [/limpiez/, /\bintendenc/, /\baseo\b/, /\bmucam/, /housekeep/] },

  // ── Choferes / Repartidores
  { label: 'Repartidor', patterns: [/repartid/, /\bdelivery/, /\bmotorizado/, /\bmensajer/, /entrega/] },
  { label: 'Chofer', patterns: [/\bchofer/, /\bconductor/, /\boperador\s+de\s+(camion|trailer|tractocami)/, /motorista/] },

  // ── Almacén y operación industrial
  { label: 'Almacenista', patterns: [/almacenist/, /\balmac[eé]n\b/, /bodeguer/, /montacarguist/, /\bsurtidor/, /cargador/, /estibador/, /descargador/] },
  { label: 'Operador Industrial', patterns: [
    /operador industrial/, /operario industrial/, /operador de m[áa]quin/, /\bobrero/,
    /operador general/, /\boperador\b/,           // catch-all para "operador X" no específico
  ] },

  // ── Mantenimiento (consolida Mecánico)
  { label: 'Mantenimiento', patterns: [
    /mantenimient/, /electricis/, /plomer/, /alban|albañil/, /\bherrer/, /carpinter/, /\bsoldador/, /pintor\b/,
    /mec[áa]nic/, /hojalater/,                   // ← Mecánico merged
  ] },

  // ── Cajero / Call Center (consolida Gestor de Cobranza)
  { label: 'Cajero', patterns: [/\bcajer/] },
  { label: 'Call Center', patterns: [
    /call ?center/, /\bcallcenter/, /telemark/, /telefonist/,
    /cobran[zs]a/, /\bgestor\s+de\s+cobran/,     // ← Gestor de Cobranza merged
  ] },

  // ── Administrativos / oficina (más específicos primero)
  { label: 'Recepcionista', patterns: [/recepcionis/, /\brecepción\b/, /\brecepcion\b/] },
  { label: 'Auxiliar Administrativo', patterns: [/auxiliar admin/, /asistent/, /secretari/, /oficinist/, /administrativ/] },
  { label: 'Contador', patterns: [/\bcontador/, /contabil/] },

  // ── Especializados
  { label: 'Enfermería', patterns: [/enfermer/, /\bparamedic/, /paramédic/] },
  { label: 'Técnico', patterns: [/t[ée]cnico/] },
  { label: 'Reclutador', patterns: [/reclutad/] },

  // ── Comercial (Promotor también va acá)
  { label: 'Ventas', patterns: [
    /\bventas?\b/, /\bvendedor/, /\bvendedora/, /comercial/,
    /\basesor\b/, /asesores?\b/, /asesor[ae]s?\s+(comercial|de venta|de seguros?|inmobiliari)/,
    /ejecutivo de venta/, /ejecutivos comerciales/,
    /preventist/, /cambaceo/,
    /\bpromot/, /\bimpulsador/, /\bdemostrador/,   // ← Promotor merged (poco volumen)
    /\bseguros?\b/,                                 // "Asesores de seguros" → Ventas
  ] },

  // ── Gerente / Director (catch-all de liderazgo)
  { label: 'Gerente', patterns: [/gerent/, /\bdirector/, /\bjefe/, /\bsuperviso/, /coordinad/, /\bmanager\b/, /\bhead\b/] },

  // ── Ayudante general (catch-all final para roles genéricos — consolida Operativos + Multifuncional)
  { label: 'Ayudante general', patterns: [
    /ayudante[s]?\s+general/, /\bayudant/, /\bauxiliar\b/,
    /operativ/,                                  // ← Operativos merged
    /multifuncional/,                            // ← Multifuncional merged
    /\bpeón\b/, /\bpeon\b/,
  ] },
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
