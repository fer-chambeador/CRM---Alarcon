import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/aprobaciones — lista aprobaciones pending con el lead embebido.
 *
 * Response: { vambe: [...], dapta: [...], counts: { vambe, dapta } }
 *
 * NO requiere auth — el dashboard es del único user. Si abrimos multi-user,
 * agregamos check de sesión.
 */
export async function GET() {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('aprobaciones')
    .select(`
      *,
      leads:lead_id (
        id, nombre, email, empresa, telefono, vacante, presupuesto, puesto,
        status, canal_adquisicion, llamada_at, monto, notas, created_at
      )
    `)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  type Row = {
    id: string
    tipo: 'vambe_template' | 'dapta_call'
    lead_id: string
    leads: Record<string, unknown> | null
    [k: string]: unknown
  }
  const rows = (data || []) as Row[]
  const vambe = rows.filter(r => r.tipo === 'vambe_template')
  const dapta = rows.filter(r => r.tipo === 'dapta_call')
  return NextResponse.json({
    vambe,
    dapta,
    counts: { vambe: vambe.length, dapta: dapta.length, total: vambe.length + dapta.length },
  })
}
