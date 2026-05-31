import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/llamadas/[id] — detalle de una llamada (con join al lead).
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('llamadas')
    .select(`
      *,
      leads:lead_id ( id, nombre, email, empresa, telefono, status, presupuesto, vacante, notas, canal_adquisicion )
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'no encontrada' }, { status: 404 })
  return NextResponse.json(data)
}
