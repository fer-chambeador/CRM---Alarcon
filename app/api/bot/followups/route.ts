import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { requireBotAuth } from '../_lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bot/followups
 *
 * Regla Fer: 24h después de propuesta/liga sin respuesta = urgente.
 * 48h más si no contestan = super-urgente.
 *
 * Devuelve 3 buckets:
 *  - propuesta_24h+   : status presentacion_enviada, ultimo_contacto > 24h
 *  - liga_48h+        : status liga_pago_enviada, ultimo_contacto > 48h
 *  - llamada_pendiente_24h+: status llamada_agendada del pasado (no_show implícito)
 *
 * Auth: header x-bot-secret
 */
export async function GET(req: NextRequest) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  const supabase = createServiceClient()
  const now = Date.now()
  const cutoff24 = new Date(now - 24 * 3600 * 1000).toISOString()
  const cutoff48 = new Date(now - 48 * 3600 * 1000).toISOString()
  const nowIso = new Date(now).toISOString()

  const cols = 'id,nombre,empresa,telefono,canal_adquisicion,presupuesto,puesto,ultimo_contacto,status,monto'

  const [prop, liga, llam] = await Promise.all([
    supabase
      .from('leads').select(cols)
      .eq('status', 'presentacion_enviada')
      .lte('ultimo_contacto', cutoff24)
      .order('ultimo_contacto')
      .limit(30),
    supabase
      .from('leads').select(cols)
      .eq('status', 'liga_pago_enviada')
      .lte('ultimo_contacto', cutoff48)
      .order('ultimo_contacto')
      .limit(30),
    // llamada agendada en el pasado (no_show suele quedar como llamada_agendada)
    supabase
      .from('leads').select(cols + ',llamadas:llamadas!lead_id(scheduled_at,status)')
      .eq('status', 'llamada_agendada')
      .lte('ultimo_contacto', cutoff24)
      .order('ultimo_contacto')
      .limit(30),
  ])

  if (prop.error || liga.error || llam.error) {
    return NextResponse.json({
      error: prop.error?.message || liga.error?.message || llam.error?.message,
    }, { status: 500 })
  }

  return NextResponse.json({
    at: nowIso,
    propuesta_24h: prop.data || [],
    liga_pago_48h: liga.data || [],
    llamada_pendiente_24h: llam.data || [],
    total: (prop.data?.length || 0) + (liga.data?.length || 0) + (llam.data?.length || 0),
  })
}
