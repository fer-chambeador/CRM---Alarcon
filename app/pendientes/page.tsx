import { createServiceClient } from '@/lib/supabase'
import PendientesClient from '@/components/PendientesClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function PendientesPage() {
  const supabase = createServiceClient()
  const { data: leads } = await supabase
    .from('leads')
    .select('id,email,nombre,empresa,telefono,puesto,canal_adquisicion,status,veces_contactado,ultimo_contacto,plan,cupon,suscripcion_fecha,monto,estado,presupuesto,vacante,llamada_at,notas,tipo_evento,slack_ts,created_at,updated_at,status_changed_at,google_calendar_event_id,gcal_followup_event_id,vambe_contact_id,vambe_stage_id,tipo_llamada')
    .order('created_at', { ascending: false })

  return <PendientesClient initialLeads={leads || []} />
}
