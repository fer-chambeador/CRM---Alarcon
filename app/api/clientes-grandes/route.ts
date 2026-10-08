import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, fetchAllRows } from '@/lib/supabase'
import { cargarFuenteVerdad, type FuenteVerdadInfo } from '@/lib/fuenteVerdad'
import { fetchClientesDelSheet, ownerDesdeCanal, saludPorPago, SALUDES, UMBRAL_CLIENTE_GRANDE, type Salud } from '@/lib/clientesGrandes'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export type ClienteGrandeRow = {
  key: string
  empresa: string | null
  email: string | null
  contacto_nombre: string | null
  contacto_puesto: string | null
  telefono: string | null
  owner: string
  total: number
  pagos: number
  vacantes: number
  primer_pago: string | null
  ultimo_pago: string | null
  canal: string | null
  plan: string | null
  proxima_accion: string | null
  proxima_accion_fecha: string | null
  ultimo_contacto: string | null
  notas: string | null
  origen: 'sheet' | 'manual'
  salud: Salud
  fv: FuenteVerdadInfo | null
  salud_manual: boolean
  lead_id: string | null
}

type DbRow = {
  cliente_key: string; empresa: string | null; contacto_nombre: string | null; contacto_puesto: string | null
  telefono: string | null; email: string | null; owner: string; gasto_manual: number | null; plan: string | null
  proxima_accion: string | null; proxima_accion_fecha: string | null; ultimo_contacto: string | null
  notas: string | null; origen: 'sheet' | 'manual'; eliminado: boolean; created_at: string; salud?: string | null
}

/**
 * GET /api/clientes-grandes
 * Lista = clientes del sheet 'Revenue' (enero → hoy) con pagos > $5,000
 *       + clientes agregados a mano,
 *       − los marcados como eliminados.
 * Se enriquece con el lead del CRM (match por email) para empresa/contacto.
 */
export async function GET() {
  const supabase = createServiceClient()
  const [{ clientes, pestañas, errores }, dbRes, fuente] = await Promise.all([
    fetchClientesDelSheet(),
    supabase.from('clientes_grandes').select('*'),
    cargarFuenteVerdad(),
  ])
  const tablaLista = !dbRes.error
  const db = new Map<string, DbRow>(((dbRes.data || []) as DbRow[]).map(r => [r.cliente_key, r]))

  // Leads del CRM para completar empresa / nombre / teléfono por email
  const emails = clientes.map(c => c.key).filter(e => e.includes('@'))
  const leadsByEmail = new Map<string, { id: string; empresa: string | null; nombre: string | null; telefono: string | null; puesto: string | null }>()
  if (emails.length) {
    const leads = await fetchAllRows<{ id: string; email: string; empresa: string | null; nombre: string | null; telefono: string | null; puesto: string | null }>((from, to) =>
      supabase.from('leads').select('id,email,empresa,nombre,telefono,puesto').not('email', 'is', null).range(from, to))
    // Match por correo sin importar mayúsculas/espacios; si hay varios leads con
    // el mismo correo, gana el que tiene teléfono (WhatsApp del owner de la cuenta).
    const wanted = new Set(emails)
    for (const l of leads) {
      const k = (l.email || '').trim().toLowerCase()
      if (!wanted.has(k)) continue
      const prev = leadsByEmail.get(k)
      if (!prev || (!prev.telefono && l.telefono)) leadsByEmail.set(k, l)
    }
  }

  const out: ClienteGrandeRow[] = []
  for (const c of clientes) {
    const d = db.get(c.key)
    if (d?.eliminado) continue
    const l = leadsByEmail.get(c.key)
    const fv = fuente.buscar(c.key.includes('@') ? c.key : null, d?.empresa || l?.empresa || c.cliente)
    out.push({
      fv,
      key: c.key,
      empresa: d?.empresa || fv?.empresa || l?.empresa || (c.key.includes('@') ? null : c.cliente),
      email: d?.email || (c.key.includes('@') ? c.key : null),
      contacto_nombre: d?.contacto_nombre || l?.nombre || null,
      contacto_puesto: d?.contacto_puesto || l?.puesto || null,
      // WhatsApp: el que puso el operador > Fuente de Verdad (owner de la cuenta) > lead del CRM
      telefono: d?.telefono || fv?.wa || l?.telefono || null,
      owner: d?.owner || ownerDesdeCanal(c.canal),
      total: c.total, pagos: c.pagos, vacantes: c.vacantes,
      primer_pago: c.primer_pago, ultimo_pago: c.ultimo_pago, canal: c.canal,
      plan: d?.plan || null,
      proxima_accion: d?.proxima_accion || null,
      proxima_accion_fecha: d?.proxima_accion_fecha || null,
      ultimo_contacto: d?.ultimo_contacto || null,
      notas: d?.notas || null,
      origen: 'sheet',
      salud: SALUDES.includes(d?.salud as Salud) ? d!.salud as Salud : saludPorPago(c.ultimo_pago),
      salud_manual: SALUDES.includes(d?.salud as Salud),
      lead_id: l?.id || null,
    })
  }
  // Agregados a mano (no vienen del sheet)
  const keysSheet = new Set(clientes.map(c => c.key))
  for (const d of db.values()) {
    if (d.eliminado || d.origen !== 'manual' || keysSheet.has(d.cliente_key)) continue
    const fvm = fuente.buscar(d.email, d.empresa)
    out.push({
      fv: fvm,
      key: d.cliente_key, empresa: d.empresa, email: d.email, contacto_nombre: d.contacto_nombre,
      contacto_puesto: d.contacto_puesto, telefono: d.telefono || fvm?.wa || null, owner: d.owner,
      total: Number(d.gasto_manual || 0), pagos: 0, vacantes: 0, primer_pago: null,
      ultimo_pago: null, canal: null, plan: d.plan, proxima_accion: d.proxima_accion,
      proxima_accion_fecha: d.proxima_accion_fecha, ultimo_contacto: d.ultimo_contacto,
      notas: d.notas, origen: 'manual', salud: SALUDES.includes(d.salud as Salud) ? d.salud as Salud : 'espera', salud_manual: SALUDES.includes(d.salud as Salud), lead_id: null,
    })
  }
  out.sort((a, b) => b.total - a.total)
  return NextResponse.json({ ok: true, clientes: out, umbral: UMBRAL_CLIENTE_GRANDE, pestañas, errores, tablaLista, fuenteVerdad: fuente.ok })
}

/** POST /api/clientes-grandes — agregar cliente a mano. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const empresa = String(body.empresa || '').trim()
  if (!empresa) return NextResponse.json({ ok: false, error: 'La empresa es obligatoria' }, { status: 400 })
  const email = String(body.email || '').trim().toLowerCase() || null
  const supabase = createServiceClient()
  const row = {
    cliente_key: email || `manual:${crypto.randomUUID()}`,
    empresa, email,
    contacto_nombre: body.contacto_nombre || null,
    contacto_puesto: body.contacto_puesto || null,
    telefono: body.telefono || null,
    owner: body.owner || 'Sin asignar',
    gasto_manual: body.gasto != null && body.gasto !== '' ? Number(String(body.gasto).replace(/[^0-9.]/g, '')) : null,
    plan: body.plan || null,
    proxima_accion: body.proxima_accion || null,
    proxima_accion_fecha: body.proxima_accion_fecha || null,
    notas: body.notas || null,
    origen: 'manual', eliminado: false, updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase.from('clientes_grandes').upsert(row, { onConflict: 'cliente_key' }).select().single()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, cliente: data })
}
