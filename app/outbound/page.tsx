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
      .select('id,email,nombre,empresa,telefono,puesto,canal_adquisicion,status,veces_contactado,ultimo_contacto,plan,cupon,suscripcion_fecha,monto,estado,presupuesto,vacante,llamada_at,notas,tipo_evento,slack_ts,created_at,updated_at,status_changed_at,google_calendar_event_id,gcal_followup_event_id,vambe_contact_id,vambe_stage_id,tipo_llamada')
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
