import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { requireBotAuth } from '../_lib/auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * GET /api/bot/leads
 *
 * Query params (todos opcionales):
 *   status         - filtro exacto (ej: llamada_agendada, propuesta_enviada, etc.)
 *   canal          - substring match en canal_adquisicion (ilike)
 *   nombre         - substring match en nombre o empresa
 *   telefono       - substring en telefono
 *   min_dias_sin_contacto  - int (usa ultimo_contacto)
 *   presupuesto    - none | 100_to_1000 | 2000_to_5000 | 10000_plus
 *   limit          - default 30, max 100
 *   order          - default updated_at desc (opts: created_at, ultimo_contacto)
 *
 * Auth: header x-bot-secret
 */
export async function GET(req: NextRequest) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const canal = url.searchParams.get('canal')
  const nombre = url.searchParams.get('nombre')
  const telefono = url.searchParams.get('telefono')
  const minDias = url.searchParams.get('min_dias_sin_contacto')
  const presupuesto = url.searchParams.get('presupuesto')
  const orderBy = (url.searchParams.get('order') || 'updated_at') as 'updated_at' | 'created_at' | 'ultimo_contacto'
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30', 10), 100)

  const supabase = createServiceClient()
  let q = supabase
    .from('leads')
    .select('id,nombre,empresa,telefono,email,status,canal_adquisicion,presupuesto,puesto,ultimo_contacto,veces_contactado,monto,created_at,updated_at')

  if (status) q = q.eq('status', status)
  if (canal) q = q.ilike('canal_adquisicion', `%${canal}%`)
  if (nombre) {
    // busca en nombre O empresa
    q = q.or(`nombre.ilike.%${nombre}%,empresa.ilike.%${nombre}%`)
  }
  if (telefono) q = q.ilike('telefono', `%${telefono}%`)
  if (presupuesto) q = q.eq('presupuesto', presupuesto)
  if (minDias) {
    const days = parseInt(minDias, 10)
    if (!isNaN(days)) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
      q = q.lte('ultimo_contacto', cutoff)
    }
  }

  q = q.order(orderBy, { ascending: false }).limit(limit)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ count: data?.length || 0, leads: data || [] })
}
