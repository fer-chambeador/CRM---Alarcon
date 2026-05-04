import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase'
import { parseSlackMessage } from '@/lib/slack-parser'

function verifySlackSignature(req: NextRequest, body: string): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret) return false
  const timestamp = req.headers.get('x-slack-request-timestamp')
  const signature = req.headers.get('x-slack-signature')
  if (!timestamp || !signature) return false
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
  if (!verifySlackSignature(req, rawBody)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(rawBody)
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  if (payload.type === 'event_callback') {
    const event = payload.event
    if (event.type !== 'message' || event.subtype || !event.text) {
      return NextResponse.json({ ok: true })
    }

    const parsed = parseSlackMessage(event.text)
    if (!parsed || !parsed.email) return NextResponse.json({ ok: true })

    const supabase = createServiceClient()
    const { data: existing } = await supabase.from('leads').select('*').eq('email', parsed.email).single()

    // ── Pago confirmado → convertir automáticamente ──
    if (parsed.tipo_evento === 'pago_confirmado') {
      if (existing) {
        await supabase.from('leads').update({
          status: 'convertido',
          plan: parsed.plan || existing.plan,
          nombre: parsed.nombre || existing.nombre,
          suscripcion_fecha: new Date().toISOString(),
        }).eq('id', existing.id)
        await supabase.from('lead_actividad').insert({
          lead_id: existing.id,
          tipo: 'slack_update',
          descripcion: `Pago confirmado - Monto: $${parsed.monto} MXN`,
          metadata: { monto: parsed.monto, plan: parsed.plan },
        })
      }
      return NextResponse.json({ ok: true })
    }

    // ── Compañia creada → solo insertar si tiene todos los campos ──
    if (parsed.tipo_evento === 'empresa_creada') {
      if (!parsed.telefono || !parsed.puesto || !parsed.canal_adquisicion || !parsed.empresa) {
        return NextResponse.json({ ok: true })
      }

      if (existing) {
        const updates: Record<string, unknown> = {}
        if (parsed.empresa && !existing.empresa) updates.empresa = parsed.empresa
        if (parsed.telefono && !existing.telefono) updates.telefono = parsed.telefono
        if (parsed.puesto && !existing.puesto) updates.puesto = parsed.puesto
        if (parsed.canal_adquisicion && !existing.canal_adquisicion) updates.canal_adquisicion = parsed.canal_adquisicion
        if (Object.keys(updates).length > 0) {
          await supabase.from('leads').update(updates).eq('id', existing.id)
        }
      } else {
        const { data: newLead } = await supabase.from('leads').insert({
          email: parsed.email,
          nombre: parsed.nombre,
          empresa: parsed.empresa,
          telefono: parsed.telefono,
          puesto: parsed.puesto,
          canal_adquisicion: parsed.canal_adquisicion,
          status: 'nuevo',
          tipo_evento: parsed.tipo_evento,
          slack_ts: event.ts,
          slack_raw: event.text,
        }).select('id').single()
        if (newLead) {
          await supabase.from('lead_actividad').insert({ lead_id: newLead.id, tipo: 'slack_update', descripcion: 'Lead creado desde Slack', metadata: { slack_ts: event.ts } })
        }
      }
    }

    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: true })
}
