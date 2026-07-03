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
    console.error('[slack-webhook] SIG_FAIL body_len=' + rawBody.length)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(rawBody)
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  if (payload.type === 'event_callback') {
    const event = payload.event
    // ── LOGGING para diagnóstico de la 5ta regresión #canirac ────────────
    // Cada Slack event nos importa saber: qué canal, qué subtype, si tiene texto
    // Sin esto no podemos diagnosticar por qué mensajes de "Chambas Alert" no
    // entran al CRM. Buscar en Railway logs con: "[slack-webhook]"
    const dbgChannel = event.channel || event.channel_id || 'unknown'
    const dbgSubtype = event.subtype || '(none)'
    const dbgHasText = !!(event.text && event.text.length > 0)
    const dbgHasBlocks = Array.isArray(event.blocks) && event.blocks.length > 0
    const dbgHasAtt = Array.isArray(event.attachments) && event.attachments.length > 0
    console.log(`[slack-webhook] IN channel=${dbgChannel} subtype=${dbgSubtype} hasText=${dbgHasText} hasBlocks=${dbgHasBlocks} hasAtt=${dbgHasAtt} botId=${event.bot_id || '-'} user=${event.user || '-'}`)

    // Aceptar mensajes de usuarios humanos (sin subtype) Y mensajes del bot
    // "Chambas Alert" que envía con subtype='bot_message'. Sin esto, NINGÚN
    // lead del onboarding (panel.chambas.ai) entra al CRM, porque todos llegan
    // via el bot a canales #leads-sales / #check-in-entrevistas.
    // Otros subtypes (channel_join, message_changed, etc.) se siguen ignorando.
    // FIX 2-jul-2026: aceptar también mensajes con event.bot_id (sin subtype)
    // por si Slack ahora manda ese formato para bots nuevos.
    const subtype = event.subtype
    const isBotByBotId = !!event.bot_id && !subtype
    const isValidSubtype = !subtype || subtype === 'bot_message'
    if (event.type !== 'message' || (!isValidSubtype && !isBotByBotId)) {
      console.log(`[slack-webhook] SKIP type=${event.type} subtype=${dbgSubtype} bot_id=${event.bot_id || '-'}`)
      return NextResponse.json({ ok: true })
    }

    // BUG FIX (15-jun-2026, regresión): el bot "Chambas Alert" en #canirac
    // envía mensajes con el contenido en `event.attachments[].text` y/o
    // `event.blocks` (mrkdwn sections), no en `event.text` que puede llegar
    // vacío. Si solo miramos event.text, perdemos TODOS los leads que ese
    // bot pushea (Mr Rib Eye, etc.). Combinamos las 3 fuentes.
    function extractFromBlocks(blocks: unknown): string {
      if (!Array.isArray(blocks)) return ''
      const out: string[] = []
      for (const block of blocks as Array<Record<string, unknown>>) {
        const text = block.text as { text?: string } | undefined
        if (text?.text) out.push(text.text)
        const fields = block.fields as Array<{ text?: string }> | undefined
        if (Array.isArray(fields)) for (const f of fields) if (f?.text) out.push(f.text)
        const elements = block.elements as Array<Record<string, unknown>> | undefined
        if (Array.isArray(elements)) {
          for (const el of elements) {
            const elText = el.text as { text?: string } | string | undefined
            if (typeof elText === 'string') out.push(elText)
            else if (elText?.text) out.push(elText.text)
          }
        }
      }
      return out.join('\n')
    }
    function extractFromAttachments(att: unknown): string {
      if (!Array.isArray(att)) return ''
      const out: string[] = []
      for (const a of att as Array<Record<string, unknown>>) {
        if (typeof a.text === 'string') out.push(a.text)
        if (typeof a.pretext === 'string') out.push(a.pretext)
        if (typeof a.fallback === 'string') out.push(a.fallback)
        const fields = a.fields as Array<{ title?: string; value?: string }> | undefined
        if (Array.isArray(fields)) {
          for (const f of fields) {
            if (f.title || f.value) out.push(`${f.title || ''}: ${f.value || ''}`)
          }
        }
        if (Array.isArray(a.blocks)) out.push(extractFromBlocks(a.blocks))
      }
      return out.join('\n')
    }

    const candidates = [
      typeof event.text === 'string' ? event.text : '',
      extractFromAttachments(event.attachments),
      extractFromBlocks(event.blocks),
    ].filter(Boolean)
    const fullText = candidates.join('\n').trim()

    if (!fullText) {
      console.log(`[slack-webhook] NO_TEXT channel=${dbgChannel} subtype=${dbgSubtype}`)
      return NextResponse.json({ ok: true, reason: 'no text' })
    }

    const parsed = parseSlackMessage(fullText)
    if (!parsed || !parsed.email) {
      // Preview de texto para poder ver en Railway logs QUÉ mensaje llegó y NO parseó
      const preview = fullText.slice(0, 250).replace(/\n/g, ' | ')
      console.log(`[slack-webhook] PARSE_FAIL channel=${dbgChannel} textLen=${fullText.length} preview="${preview}"`)
      return NextResponse.json({ ok: true, reason: 'parse_fail' })
    }
    console.log(`[slack-webhook] PARSED tipo=${parsed.tipo_evento} email=${parsed.email} canal=${parsed.canal_adquisicion || '-'} tel=${parsed.telefono || '-'} empresa=${parsed.empresa || '-'}`)

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
    // REGLA (Fer, 2 jun 2026 — ACTUALIZADA, reemplaza la regla 1 jun):
    // Cualquier pago confirmado marca el lead como 'convertido'. La
    // promoción a 'cliente_recurrente' la hace el cron mensual
    // /api/cron/promote-recurrentes que corre el día 1 de cada mes a las
    // 00:05 CDMX — promueve los 'convertido' del mes ANTERIOR a
    // 'cliente_recurrente'. Así el reporte del mes distingue
    // clientes-nuevos-del-mes (status=convertido) de los que ya pagaron
    // antes (status=cliente_recurrente).
    if (parsed.tipo_evento === 'pago_confirmado') {
      if (existing) {
        await supabase.from('leads').update({
          status: 'convertido',
          plan: parsed.plan || existing.plan,
          nombre: parsed.nombre || existing.nombre,
          suscripcion_fecha: new Date().toISOString(),
          status_changed_at: new Date().toISOString(),
        }).eq('id', existing.id)
        await supabase.from('lead_actividad').insert({
          lead_id: existing.id,
          tipo: 'slack_update',
          descripcion: `Pago confirmado - Monto: $${parsed.monto} MXN`,
          metadata: { monto: parsed.monto, plan: parsed.plan, target_status: 'convertido' },
        })
      }
      return NextResponse.json({ ok: true })
    }

    // ── Compañia creada → solo insertar si tiene todos los campos ──
    if (parsed.tipo_evento === 'empresa_creada') {
      if (!parsed.telefono || !parsed.puesto || !parsed.canal_adquisicion || !parsed.empresa) {
        const missing = [
          !parsed.telefono && 'tel',
          !parsed.puesto && 'puesto',
          !parsed.canal_adquisicion && 'canal',
          !parsed.empresa && 'empresa',
        ].filter(Boolean).join(',')
        console.log(`[slack-webhook] MISSING_FIELDS email=${parsed.email} missing=${missing}`)
        return NextResponse.json({ ok: true, reason: 'missing_fields', missing })
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
        const { data: newLead, error: insertErr } = await supabase.from('leads').insert({
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
        if (insertErr) {
          console.error(`[slack-webhook] INSERT_ERR email=${parsed.email} err=${insertErr.message}`)
        } else if (newLead) {
          console.log(`[slack-webhook] CREATED lead_id=${newLead.id} email=${parsed.email} canal=${parsed.canal_adquisicion}`)
          await supabase.from('lead_actividad').insert({ lead_id: newLead.id, tipo: 'slack_update', descripcion: 'Lead creado desde Slack', metadata: { slack_ts: event.ts } })
        }
      }
    }

    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: true })
}
