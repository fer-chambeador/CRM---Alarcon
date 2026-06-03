import { createClient } from '@supabase/supabase-js'

// El módulo se evalúa durante `next build` (page data collection).
// Si las env vars no están disponibles en build-time (Railway no siempre
// las expone al builder), usamos placeholders para no tirar abajo el build.
// En runtime las env vars reales están presentes.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: { params: { eventsPerSecond: 10 } },
})

// Client con privilegios de servicio (solo para API routes del servidor).
// Acá sí explotamos si faltan vars en runtime — no queremos queries
// silenciosas contra un placeholder.
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('Supabase env vars no configuradas (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  }
  return createClient(url, serviceKey)
}

export type Lead = {
  id: string
  email: string
  nombre: string | null
  empresa: string | null
  telefono: string | null
  puesto: string | null
  canal_adquisicion: string | null
  status: 'nuevo' | 'contactado' | 'llamada_con_dapta' | 'llamada_agendada' | 'no_show_llamada' | 'presentacion_enviada' | 'espera_aprobacion' | 'liga_pago_enviada' | 'convertido' | 'cliente_recurrente' | 'descartado'
  veces_contactado: number
  ultimo_contacto: string | null
  plan: string | null
  cupon: string | null
  suscripcion_fecha: string | null
  monto: number
  estado: string | null
  presupuesto: 'none' | '100_to_1000' | '2000_to_5000' | '10000_plus' | null
  vacante: string | null
  llamada_at: string | null
  notas: string | null
  tipo_evento: string | null
  slack_ts: string | null
  created_at: string
  updated_at: string
  status_changed_at: string
  google_calendar_event_id: string | null
  gcal_followup_event_id: string | null
  vambe_contact_id: string | null
  vambe_stage_id: string | null
  tipo_llamada: 'demo' | 'comercial' | null
}

export type LeadActividad = {
  id: string
  lead_id: string
  tipo: string
  descripcion: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}
