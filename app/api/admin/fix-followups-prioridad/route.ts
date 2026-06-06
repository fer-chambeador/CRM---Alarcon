import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * Fix prioridad de follow-ups creados sin prioridad explícita
 * (porque PATCH viejo no aceptaba el campo).
 * Reglas:
 *   - tipo='pago' → urgente
 *   - tipo='llamada' Y fecha en próximos 3 días → urgente
 *   - tipo='presentacion' → normal (ya están propuestas enviadas)
 *   - tipo='mensaje' → normal
 *   - tipo='general' → normal
 *
 * Protegido por ?secret= que matchea DAPTA_POST_CALL_SECRET.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || ''
  const expected = process.env.DAPTA_POST_CALL_SECRET || ''
  if (!expected || secret !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const now = new Date()
  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)

  // Update tipo='pago' → urgente
  const pagos = await supabase
    .from('follow_ups')
    .update({ prioridad: 'urgente' })
    .eq('tipo', 'pago')
    .eq('completado', false)
    .select('id')

  // Update tipo='llamada' con fecha próxima → urgente
  const llamadas = await supabase
    .from('follow_ups')
    .update({ prioridad: 'urgente' })
    .eq('tipo', 'llamada')
    .eq('completado', false)
    .lt('fecha', in3Days.toISOString())
    .select('id')

  return NextResponse.json({
    ok: true,
    pago_urgente: pagos.data?.length || 0,
    llamada_urgente: llamadas.data?.length || 0,
  })
}
