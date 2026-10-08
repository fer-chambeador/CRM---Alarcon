// Fuente de Verdad (chambas-customers.vercel.app) → datos de éxito por cliente
// para Clientes grandes (Fer, 7-oct-2026). Se leen dos endpoints públicos:
//   /api/data          → cuentas activas (métricas 30d, salud, vence, wa)
//   /api/renovaciones  → roster de renovaciones del mes (renueva, estatus, teléfono)
// Match por correo (email principal + team_emails) y, si no hay correo, por
// nombre de empresa normalizado. Cache 5 min en el servidor.

const BASE = process.env.FUENTE_VERDAD_URL || 'https://chambas-customers.vercel.app'

export type FuenteVerdadInfo = {
  encontrado: boolean
  activo: boolean                 // está en las cuentas activas de la Fuente de Verdad
  empresa: string | null
  tipo_cliente: string | null     // Chico / Mediano / Grande
  vacantes: number | null         // vacantes activas
  post_30d: number | null
  conf_30d: number | null
  asis_30d: number | null
  contratados: number | null
  dias_sin_login: number | null
  salud_score: number | null      // 0–100
  salud_bucket: string | null     // Sano / En riesgo / Crítico
  focos: string[]
  renueva: string | null          // yyyy-mm-dd
  dias_renueva: number | null
  estado_renovacion: string | null
  wa: string | null
}

type Cuenta = Record<string, unknown> & { email?: string; team_emails?: string[]; empresa?: string }
type Renov = Record<string, unknown> & { email?: string; empresa?: string; cliente?: string; cuenta_nombre?: string }

const norm = (s: unknown) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\b(s\.?a\.?|de|c\.?v\.?|sapi|s de rl|grupo)\b/g, '').replace(/[^a-z0-9]/g, '')
const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null)
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v))
const fecha = (v: unknown): string | null => {
  const s = str(v); if (!s) return null
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/); if (iso) return iso[1]
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (dmy) return `${dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  return null
}
const diasHasta = (iso: string | null) => iso ? Math.round((new Date(iso + 'T12:00:00-06:00').getTime() - Date.now()) / 86_400_000) : null

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(BASE + path, { next: { revalidate: 300 } })
    if (!r.ok) return null
    return await r.json() as T
  } catch { return null }
}

export async function cargarFuenteVerdad(): Promise<{
  buscar: (email: string | null, empresa: string | null) => FuenteVerdadInfo | null
  ok: boolean
}> {
  const [data, renov] = await Promise.all([
    getJson<{ cuentas: Cuenta[] }>('/api/data'),
    getJson<{ items: Renov[] }>('/api/renovaciones'),
  ])
  const cuentas = data?.cuentas || []
  const items = renov?.items || []

  const cByEmail = new Map<string, Cuenta>(), cByName = new Map<string, Cuenta>()
  for (const c of cuentas) {
    for (const e of [c.email, ...(c.team_emails || [])]) if (e) cByEmail.set(String(e).trim().toLowerCase(), c)
    const n = norm(c.empresa); if (n.length >= 3 && !cByName.has(n)) cByName.set(n, c)
  }
  const rByEmail = new Map<string, Renov>(), rByName = new Map<string, Renov>()
  for (const r of items) {
    if (r.email) rByEmail.set(String(r.email).trim().toLowerCase(), r)
    for (const n of [norm(r.empresa), norm(r.cuenta_nombre), norm(r.cliente)]) if (n.length >= 3 && !rByName.has(n)) rByName.set(n, r)
  }

  const buscar = (email: string | null, empresa: string | null): FuenteVerdadInfo | null => {
    const e = (email || '').trim().toLowerCase(), n = norm(empresa)
    const c = (e && cByEmail.get(e)) || (n.length >= 3 ? cByName.get(n) : undefined)
    const r = (e && rByEmail.get(e)) || (n.length >= 3 ? rByName.get(n) : undefined)
    if (!c && !r) return null
    const renueva = fecha(r?.renueva) || fecha(c?.vence)
    const contr = num(r?.contratados) ?? num(c?.hires)
    return {
      encontrado: true,
      activo: !!c || (num(r?.activas) ?? 0) > 0,
      empresa: str(c?.empresa) || str(r?.cuenta_nombre) || str(r?.empresa),
      tipo_cliente: str(c?.tipo_cliente),
      vacantes: num(c?.vacantes) ?? num(r?.activas),
      post_30d: num(c?.post_30d) ?? num(r?.postulados),
      conf_30d: num(c?.conf_30d) ?? num(r?.confirmados),
      asis_30d: num(c?.asis_30d) ?? num(r?.asistencias),
      contratados: contr,
      dias_sin_login: num(c?.dias_sin_login),
      salud_score: num(c?.salud),
      salud_bucket: str(c?.salud_bucket),
      focos: Array.isArray(c?.focos) ? (c!.focos as string[]) : [],
      renueva,
      dias_renueva: num(r?.dias_renueva) ?? num(c?.dias_vence) ?? diasHasta(renueva),
      estado_renovacion: str(r?.estatus) || str(c?.estado_renovacion),
      wa: str(c?.wa) || str(r?.telefono),
    }
  }
  return { buscar, ok: cuentas.length > 0 || items.length > 0 }
}
