import { createServiceClient, fetchAllRows, type Lead } from '@/lib/supabase'
import AnalyticsClient from '@/components/AnalyticsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * 7-sep-2026 (Fer): "que se borren del # de leads pero que se queden en el CRM".
 *
 * Un lead NO CALIFICABLE es alguien que nunca fue un lead de verdad: entró por
 * el WhatsApp de Vambe (email placeholder <telefono>@clientes.chambas.ai) y no
 * dejó NI UNA señal de ser empleador — sin empresa, sin vacante, sin
 * presupuesto, sin puesto y sin notas del formulario. En la práctica son las
 * personas que buscan chamba, no quien contrata.
 *
 * El criterio es estricto a propósito: CUALQUIER señal de calificación lo
 * salva, para no sacar del conteo a una empresa real que llenó poco.
 *
 * OJO — esto NO es lo mismo que "descartado". Una empresa real que se trabajó y
 * no cerró SÍ cuenta como lead aunque esté descartada: quitarla del denominador
 * inflaría la conversión (tendería a 100%). Acá solo sale el ruido.
 *
 * Alcance: solo /analytics. En el CRM (/leads) estos leads siguen visibles y
 * buscables — no se borra nada de la base.
 */
function esLeadNoCalificable(lead: Lead): boolean {
  const email = (lead.email || '').toLowerCase().trim()
  if (!email.endsWith('@clientes.chambas.ai')) return false
  const vacio = (v: unknown) => v === null || v === undefined || String(v).trim() === ''
  return vacio(lead.empresa)
    && vacio(lead.vacante)
    && vacio(lead.presupuesto)
    && vacio(lead.puesto)
    && vacio(lead.notas)
}

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

  const calificables = leads.filter(l => !esLeadNoCalificable(l))
  console.log(`[analytics] leads=${leads.length} · no calificables filtrados=${leads.length - calificables.length}`)

  return <AnalyticsClient initialLeads={calificables} />
}
