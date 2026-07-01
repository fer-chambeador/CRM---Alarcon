import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { requireBotAuth } from '../_lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bot/llamadas
 *
 * Query params:
 *   from   - ISO date (default: hoy 00:00 CDMX)
 *   to     - ISO date (default: mañana 00:00 CDMX)
 *   limit  - default 30
 *
 * Devuelve llamadas agendadas en el rango, con contexto del lead (empresa,
 * presupuesto, canal, vacante).
 *
 * Auth: header x-bot-secret
 */
export async function GET(req: NextRequest) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  const url = new URL(req.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 100)

  // Default: hoy CDMX (UTC-6). Se calcula en UTC pero con offset -6h.
  const cdmxOffset = -6 * 60 * 60 * 1000
  const nowLocal = new Date(Date.now() + cdmxOffset)
  const startLocal = new Date(nowLocal)
  startLocal.setUTCHours(0, 0, 0, 0)
  const endLocal = new Date(startLocal.getTime() + 24 * 60 * 60 * 1000)

  // Volver a UTC
  const defaultFrom = new Date(startLocal.getTime() - cdmxOffset).toISOString()
  const defaultTo = new Date(endLocal.getTime() - cdmxOffset).toISOString()

  const from = url.searchParams.get('from') || defaultFrom
  const to = url.searchParams.get('to') || defaultTo

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('llamadas')
    .select(`
      id,
      scheduled_at,
      status,
      duration_seconds,
      outcome,
      lead_id,
      leads:lead_id (
        id, nombre, empresa, telefono, canal_adquisicion,
        presupuesto, puesto, status, monto, ultimo_contacto
      )
    `)
    .not('scheduled_at', 'is', null)
    .gte('scheduled_at', from)
    .lt('scheduled_at', to)
    .order('scheduled_at')
    .limit(limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    count: data?.length || 0,
    from,
    to,
    llamadas: data || [],
  })
}
