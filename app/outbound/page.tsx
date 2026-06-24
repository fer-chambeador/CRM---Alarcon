import { createServiceClient, fetchAllRows, type Lead } from '@/lib/supabase'
import { listTemplates } from '@/lib/vambe'
import OutboundClient, { type OutboundLead, type OutboundTemplate } from '@/components/OutboundClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function OutboundPage() {
  const supabase = createServiceClient()

  // Cargar TODOS los leads (sin cap de 1000) — el filtro se hace en cliente
  // para que Fer pueda combinar libremente.
  const leads = await fetchAllRows<Lead>((from, to) =>
    supabase
      .from('leads')
      .select('id, nombre, email, telefono, status, empresa, vacante, canal_adquisicion, created_at, ultimo_contacto, vambe_contact_id, vambe_stage_id')
      .order('created_at', { ascending: false })
      .range(from, to),
  )

  // Mapeo mínimo para mandar al client (no exponer columnas sensibles)
  const slim: OutboundLead[] = leads.map((l) => ({
    id: l.id,
    nombre: l.nombre,
    email: l.email,
    telefono: l.telefono,
    status: l.status,
    empresa: l.empresa,
    vacante: l.vacante,
    canal_adquisicion: l.canal_adquisicion,
    created_at: l.created_at,
    ultimo_contacto: l.ultimo_contacto ?? null,
    vambe_contact_id: (l as Lead & { vambe_contact_id?: string }).vambe_contact_id ?? null,
    vambe_stage_id: (l as Lead & { vambe_stage_id?: string }).vambe_stage_id ?? null,
  }))

  // Cargar plantillas Vambe — solo las APPROVED para que Fer no pueda intentar
  // mandar una pendiente de aprobación (Vambe rechazaría con 400).
  let templates: OutboundTemplate[] = []
  try {
    const res = await listTemplates({ status: 'APPROVED', get_all: true, channel_type: 'whatsapp' })
    templates = res.templates.map((t) => ({
      id: String(t.id || ''),
      name: String(t.name || ''),
      preview: String((t as { body?: string }).body || (t as { content?: string }).content || ''),
      category: String((t as { category?: string }).category || ''),
    }))
    // Ordenar: más recientes / más usadas arriba. Como no tenemos updated_at
    // accesible aquí, dejamos el orden que devuelve Vambe.
  } catch (e) {
    console.error('Outbound: listTemplates falló', e)
  }

  return <OutboundClient initialLeads={slim} initialTemplates={templates} />
}
