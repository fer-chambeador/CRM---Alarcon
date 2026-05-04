import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { parseSlackMessage } from '@/lib/slack-parser'

// Este endpoint hace el import histórico desde Slack (llámalo una sola vez)
// POST /api/leads/seed  con body: { messages: [...] }
export async function POST(req: NextRequest) {
  const supabase = createServiceClient()
  const { messages } = await req.json()

  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const msg of messages) {
    const parsed = parseSlackMessage(msg.text)
    if (!parsed || !parsed.email) { skipped++; continue }

    const { data: existing } = await supabase
      .from('leads')
      .select('id, nombre, empresa, telefono, puesto, canal_adquisicion, plan')
      .eq('email', parsed.email)
      .single()

    if (existing) {
      const updates: Record<string, unknown> = {}
      if (parsed.nombre && !existing.nombre) updates.nombre = parsed.nombre
      if (parsed.empresa && !existing.empresa) updates.empresa = parsed.empresa
      if (parsed.telefono && !existing.telefono) updates.telefono = parsed.telefono
      if (parsed.puesto && !existing.puesto) updates.puesto = parsed.puesto
      if (parsed.canal_adquisicion && !existing.canal_adquisicion) updates.canal_adquisicion = parsed.canal_adquisicion
      if (parsed.plan && !existing.plan) {
        updates.plan = parsed.plan
        updates.suscripcion_fecha = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : new Date().toISOString()
        updates.status = 'convertido'
      }
      if (parsed.cupon) updates.cupon = parsed.cupon

      if (Object.keys(updates).length > 0) {
        await supabase.from('leads').update(updates).eq('id', existing.id)
        updated++
      } else {
        skipped++
      }
    } else {
      const createdAt = msg.ts
        ? new Date(parseFloat(msg.ts) * 1000).toISOString()
        : new Date().toISOString()

      await supabase.from('leads').insert({
        email: parsed.email,
        nombre: parsed.nombre,
        empresa: parsed.empresa,
        telefono: parsed.telefono,
        puesto: parsed.puesto,
        canal_adquisicion: parsed.canal_adquisicion,
        plan: parsed.plan,
        cupon: parsed.cupon,
        suscripcion_fecha: parsed.plan ? createdAt : null,
        status: parsed.plan ? 'convertido' : 'nuevo',
        tipo_evento: parsed.tipo_evento,
        slack_ts: msg.ts,
        slack_raw: msg.text,
        created_at: createdAt,
      })
      inserted++
    }
  }

  return NextResponse.json({ inserted, updated, skipped })
}
