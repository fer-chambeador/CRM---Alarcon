import { createServiceClient, fetchAllRows, type Lead } from '@/lib/supabase'
import AnalyticsClient from '@/components/AnalyticsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AnalyticsPage() {
  const supabase = createServiceClient()
  // BUG FIX (23-jun-2026): Supabase default capa a 1000 rows. Con >1000 leads
  // en BD, el chart "Por día" no veía los días más viejos del periodo
  // (ej. 1-6 jun ausentes porque eran descartados al pasarse del cap).
  // fetchAllRows pagina automáticamente — mismo patrón que /leads/page.tsx.
  const leads = await fetchAllRows<Lead>((from, to) =>
    supabase
      .from('leads')
      .select('id,email,nombre,empresa,telefono,puesto,canal_adquisicion,status,veces_contactado,ultimo_contacto,plan,cupon,suscripcion_fecha,monto,estado,presupuesto,vacante,llamada_at,notas,tipo_evento,slack_ts,created_at,updated_at,status_changed_at,google_calendar_event_id,gcal_followup_event_id,vambe_contact_id,vambe_stage_id,tipo_llamada')
      .order('created_at', { ascending: false })
      .range(from, to),
  )

  return <AnalyticsClient initialLeads={leads} />
}
