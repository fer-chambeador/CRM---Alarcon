import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: { params: { eventsPerSecond: 10 } },
})

// Client con privilegios de servicio (solo para API routes del servidor)
export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export type Lead = {
  id: string
  email: string
  nombre: string | null
  empresa: string | null
  telefono: string | null
  puesto: string | null
  canal_adquisicion: string | null
  status: 'nuevo' | 'contactado' | 'llamada_agendada' | 'no_show_llamada' | 'presentacion_enviada' | 'espera_aprobacion' | 'convertido' | 'cliente_recurrente' | 'descartado'
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
}

export type LeadActividad = {
  id: string
  lead_id: string
  tipo: string
  descripcion: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}
