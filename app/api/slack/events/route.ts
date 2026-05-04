import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase'
import { parseSlackMessage } from '@/lib/slack-parser'

// Verifica que el request venga realmente de Slack
function verifySlackSignature(req: NextRequest, body: string): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret) return false

  const timestamp = req.headers.get('x-slack-request-timestamp')
  const signature = req.headers.get('x-slack-signature')

  if (!timestamp || !signature) return false

  // Evitar replay attacks (5 minutos)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp)) > 300) return false

  const baseString = `v0:${timestamp}:${body}`
  const hmac = crypto.createHmac('sha256', signingSecret)
  hmac.update(baseString)
  const computed = `v0=${hmac.digest('hex')}`

  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature))
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()

  // Verificar firma de Slack
  if (!verifySlackSignature(req, rawBody)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(rawBody)

  // Slack URL Verification challenge (primer setup)
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  // Evento de mensaje
  if (payload.type === 'event_callback') {
    const event = payload.event

    // Solo mensajes del bot Chambas Alert en el canal correcto
    // Ignorar mensajes editados, borrados, y subtypes raros
    if (
      event.type !== 'message' ||
      event.subtype ||
      !event.text
    ) {
      return NextResponse.json({ ok: true })
    }

    const parsed = parseSlackMessage(event.text)
    if (!parsed || !parsed.email) {
      return NextResponse.json({ ok: true })
    }

    const supabase = createServiceClient()

    // Buscar si ya existe el lead con este email
    const { data: existing } = await supabase
      .from('leads')
      .select('id, nombre, empresa, telefono, puesto, canal_adquisicion, plan, cupon, tipo_evento')
      .eq('email', parsed.email)
      .single()

    if (existing) {
      // Actualizar campos que llegaron en este nuevo evento (sin pisar los que ya existen)
      const updates: Record<string, unknown> = {}
      if (parsed.nombre && !existing.nombre) updates.nombre = parsed.nombre
      if (parsed.empresa && !existing.empresa) updates.empresa = parsed.empresa
      if (parsed.telefono && !existing.telefono) updates.telefono = parsed.telefono
      if (parsed.puesto && !existing.puesto) updates.puesto = parsed.puesto
      if (parsed.canal_adquisicion && !existing.canal_adquisicion) updates.canal_adquisicion = parsed.canal_adquisicion
      if (parsed.plan) {
        updates.plan = parsed.plan
        updates.suscripcion_fecha = new Date().toISOString()
        // Convertir automáticamente si llega suscripción
        updates.status = 'convertido'
      }
      if (parsed.cupon && !existing.cupon) updates.cupon = parsed.cupon

      if (Object.keys(updates).length > 0) {
        await supabase.from('leads').update(updates).eq('id', existing.id)
      }

      // Loguear actividad
      await supabase.from('lead_actividad').insert({
        lead_id: existing.id,
        tipo: 'slack_update',
        descripcion: `Nuevo evento Slack: ${parsed.tipo_evento}`,
        metadata: { tipo_evento: parsed.tipo_evento, slack_ts: event.ts },
      })
    } else {
      // Crear lead nuevo
      const { data: newLead } = await supabase
        .from('leads')
        .insert({
          email: parsed.email,
          nombre: parsed.nombre,
          empresa: parsed.empresa,
          telefono: parsed.telefono,
          puesto: parsed.puesto,
          canal_adquisicion: parsed.canal_adquisicion,
          plan: parsed.plan,
          cupon: parsed.cupon,
          suscripcion_fecha: parsed.plan ? new Date().toISOString() : null,
          status: parsed.plan ? 'convertido' : 'nuevo',
          tipo_evento: parsed.tipo_evento,
          slack_ts: event.ts,
          slack_raw: event.text,
        })
        .select('id')
        .single()

      if (newLead) {
        await supabase.from('lead_actividad').insert({
          lead_id: newLead.id,
          tipo: 'slack_update',
          descripcion: `Lead creado desde Slack: ${parsed.tipo_evento}`,
          metadata: { slack_ts: event.ts },
        })
      }
    }

    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: true })
}
