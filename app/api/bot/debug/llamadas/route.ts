import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { requireBotAuth } from '../../_lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bot/debug/llamadas
 *
 * Debug: separa llamadas con scheduled_at (agendadas) de las de historial,
 * y también muestra leads con status llamada_agendada.
 */
export async function GET(req: NextRequest) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  const supabase = createServiceClient()

  // Total tabla
  const { count: total } = await supabase
    .from('llamadas').select('*', { count: 'exact', head: true })

  // Llamadas AGENDADAS ordenadas por scheduled_at (las próximas y pasadas cercanas)
  const now = new Date()
  const cutoff = new Date(now.getTime() - 14 * 86_400_000).toISOString()  // últimas 2 semanas
  const cutoffFuture = new Date(now.getTime() + 14 * 86_400_000).toISOString()

  const { data: agendadas } = await supabase
    .from('llamadas')
    .select('id,lead_id,scheduled_at,status,outcome,started_at,leads:lead_id(nombre,empresa,telefono)')
    .not('scheduled_at', 'is', null)
    .gte('scheduled_at', cutoff)
    .lte('scheduled_at', cutoffFuture)
    .order('scheduled_at', { ascending: false })
    .limit(30)

  // Leads con status llamada_agendada — puede que "hoy" viva ahí
  const { data: leadsAgendados, count: leadsCount } = await supabase
    .from('leads')
    .select('id,nombre,empresa,telefono,status,status_changed_at,ultimo_contacto,updated_at', { count: 'exact' })
    .eq('status', 'llamada_agendada')
    .order('status_changed_at', { ascending: false })
    .limit(30)

  return NextResponse.json({
    now_utc: now.toISOString(),
    now_cdmx: new Date(now.getTime() - 6 * 3600 * 1000).toISOString().replace('Z', '-06:00'),
    llamadas_total_en_tabla: total,
    llamadas_agendadas_2_semanas: {
      count: agendadas?.length || 0,
      rows: (agendadas || []).map((l) => {
        type LeadInline = { nombre?: string; empresa?: string; telefono?: string }
        const lead: LeadInline = (Array.isArray(l.leads) ? l.leads[0] : l.leads) || {}
        return {
          id: l.id,
          scheduled_at: l.scheduled_at,
          scheduled_at_cdmx: l.scheduled_at
            ? new Date(new Date(l.scheduled_at as string).getTime() - 6 * 3600 * 1000).toISOString().replace('Z', '-06:00')
            : null,
          status: l.status,
          outcome: l.outcome,
          lead_name: lead.nombre || lead.empresa,
          telefono: lead.telefono,
        }
      }),
    },
    leads_con_status_llamada_agendada: {
      total_en_tabla: leadsCount,
      count_shown: leadsAgendados?.length || 0,
      rows: (leadsAgendados || []).map((l) => ({
        id: l.id,
        nombre: l.nombre || l.empresa,
        telefono: l.telefono,
        status_changed_at: l.status_changed_at,
        status_changed_at_cdmx: l.status_changed_at
          ? new Date(new Date(l.status_changed_at as string).getTime() - 6 * 3600 * 1000).toISOString().replace('Z', '-06:00')
          : null,
        ultimo_contacto: l.ultimo_contacto,
      })),
    },
  })
}
