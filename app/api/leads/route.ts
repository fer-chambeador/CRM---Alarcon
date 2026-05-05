import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { normalizeCanal } from '@/lib/canales'

export async function POST(req: NextRequest) {
  const supabase = createServiceClient()
  const body = await req.json()

  if (!body.email) return NextResponse.json({ error: 'Email requerido' }, { status: 400 })

  const { data, error } = await supabase.from('leads').insert({
    email: body.email.toLowerCase().trim(),
    nombre: body.nombre || null,
    empresa: body.empresa || null,
    telefono: body.telefono || null,
    puesto: body.puesto || null,
    canal_adquisicion: normalizeCanal(body.canal_adquisicion),
    notas: body.notas || null,
    monto: typeof body.monto === 'number' && body.monto >= 0 ? body.monto : 1160,
    status: 'nuevo',
    tipo_evento: 'manual',
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
