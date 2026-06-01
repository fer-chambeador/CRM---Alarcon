import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase'
import { parseSlackMessage } from '@/lib/slack-parser'
import { normalizePuesto, normalizeVacante, extractCompanyFromEmail } from '@/lib/vambeNormalize'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'

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
    const { data: existing } = await supabase.from('leads').select('*').eq('email', parsed.email).maybeSingle()

    // Normalizar campos crudos antes de cualquier insert/update — mismo tratamiento que Vambe
    const normalizedPuesto = parsed.puesto ? normalizePuesto(parsed.puesto) : null
    const normalizedVacante = parsed.vacante ? normalizeVacante(parsed.vacante) : null
    const empresaFromEmail = parsed.empresa || extractCompanyFromEmail(parsed.email)
    const normalizedTelefono = parsed.telefono ? (normalizeMexicanPhone(parsed.telefono) || parsed.telefono) : null

    // ── Detectar canal de origen para sobreescribir canal_adquisicion ──
    // Slack puede mandar el channel_id en event.channel. Si está en la lista de
    // canales de Canirac, forzamos canal='Canirac' (override del parser de texto).
    // Soporta tanto channel_id (Cxxxxx) como channel_name si Slack lo envía.
    const channelId: string = (event.channel || '').trim()
    const channelName: string = (event.channel_name || '').trim().toLowerCase()
    const caniracIds = (process.env.SLACK_CANIRAC_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
    const isCaniracChannel = (channelId && caniracIds.includes(channelId)) || channelName === 'canirac'
    if (isCaniracChannel) {
      parsed.canal_adquisicion = 'Canirac'
    }

    // ── Pago confirmado → convertir automáticamente ──
    // REGLA NUEVA (Fer, 1 jun 2026): cualquier pago confirmado a partir del 1 de
    // Junio 2026 marca el lead como 'cliente_recurrente' (no 'convertido'). Los
    // pagos antes de esa fecha siguen siendo 'convertido' (no rebreak histórico).
    const RECURRENTE_CUTOFF = new Date('2026-06-01T00:00:00-06:00').getTime() // CDMX
    if (parsed.tipo_evento === 'pago_confirmado') {
      if (existing) {
        const nowMs = Date.now()
        const targetStatus: 'convertido' | 'cliente_recurrente' = nowMs >= RECURRENTE_CUTOFF
          ? 'cliente_recurrente'
          : 'convertido'
        await supabase.from('leads').update({
          status: targetStatus,
          plan: parsed.plan || existing.plan,
          nombre: parsed.nombre || existing.nombre,
          suscripcion_fecha: new Date().toISOString(),
          status_changed_at: new Date().toISOString(),
        }).eq('id', existing.id)
        await supabase.from('lead_actividad').insert({
          lead_id: existing.id,
          tipo: 'slack_update',
          descripcion: targetStatus === 'cliente_recurrente'
            ? `💎 Pago confirmado — promovido a Cliente Recurrente (post-1jun2026) - Monto: $${parsed.monto} MXN`
            : `Pago confirmado - Monto: $${parsed.monto} MXN`,
          metadata: { monto: parsed.monto, plan: parsed.plan, target_status: targetStatus },
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
        if (empresaFromEmail && !existing.empresa) updates.empresa = empresaFromEmail
        if (normalizedTelefono && !existing.telefono) updates.telefono = normalizedTelefono
        if (normalizedPuesto && !existing.puesto) updates.puesto = normalizedPuesto
        if (parsed.canal_adquisicion && !existing.canal_adquisicion) updates.canal_adquisicion = parsed.canal_adquisicion
        if (parsed.presupuesto && !existing.presupuesto) updates.presupuesto = parsed.presupuesto
        if (normalizedVacante && !existing.vacante) updates.vacante = normalizedVacante
        if (Object.keys(updates).length > 0) {
          await supabase.from('leads').update(updates).eq('id', existing.id)
        }
      } else {
        const { data: newLead } = await supabase.from('leads').insert({
          email: parsed.email.toLowerCase().trim(),
          nombre: parsed.nombre,
          empresa: empresaFromEmail,
          telefono: normalizedTelefono,
          puesto: normalizedPuesto,
          canal_adquisicion: parsed.canal_adquisicion,
          presupuesto: parsed.presupuesto,
          vacante: normalizedVacante,
          status: 'nuevo',
          tipo_evento: parsed.tipo_evento,
          slack_ts: event.ts,
          slack_raw: event.text,
        }).select('id').maybeSingle()
        if (newLead) {
          await supabase.from('lead_actividad').insert({ lead_id: newLead.id, tipo: 'slack_update', descripcion: 'Lead creado desde Slack', metadata: { slack_ts: event.ts } })
        }
      }
    }

    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: true })
}
