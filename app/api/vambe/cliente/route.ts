import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * Filtro "¿ya es cliente?" para los bots de Vambe (Fer, 16-oct-2026).
 *
 * Problema: clientes que ya tienen cuenta escriben al número de ventas a pedir
 * ayuda y el bot de ventas les quiere vender / agendar → se desesperan.
 *
 * GET  /api/vambe/cliente?tel=5512345678
 *   → { es_cliente, empresa, vacantes_activas, renueva, fuente, soporte_whatsapp }
 *   Busca el teléfono (últimos 10 dígitos) en:
 *     1. Fuente de Verdad /api/data       (cuentas activas, campo wa)
 *     2. Fuente de Verdad /api/renovaciones (roster de renovación, campo telefono)
 *     3. CRM leads con status convertido / cliente_recurrente
 *
 * POST /api/vambe/cliente  { nombre, telefono, empresa?, resumen?, chat? }
 *   → alerta en #tickets-soporte para que soporte le dé seguimiento.
 *   Dedupe: 1 alerta por teléfono cada 6 h.
 */

const FV = process.env.FUENTE_VERDAD_URL || 'https://chambas-customers.vercel.app'
const SOPORTE_WA = 'https://wa.me/525554757207' // soporte: 55 5475 7207 (MX)
const SOPORTE_CHANNEL = process.env.SLACK_SOPORTE_CHANNEL_ID || 'C0BS8AET1T5' // #tickets-soporte

const last10 = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10)

type Hit = { empresa: string | null; vacantes_activas: number | null; renueva: string | null; fuente: string }

let cache: { at: number; map: Map<string, Hit> } | null = null

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(FV + path, { cache: 'no-store' })
    return r.ok ? (await r.json()) as T : null
  } catch { return null }
}

async function mapaClientes(): Promise<Map<string, Hit>> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.map
  const map = new Map<string, Hit>()
  const [data, renov] = await Promise.all([
    getJson<{ cuentas: Array<Record<string, unknown>> }>('/api/data'),
    getJson<{ items: Array<Record<string, unknown>> }>('/api/renovaciones'),
  ])
  for (const c of data?.cuentas || []) {
    const t = last10(c.wa)
    if (t.length === 10) map.set(t, {
      empresa: (c.empresa as string) || null,
      vacantes_activas: typeof c.vacantes === 'number' ? c.vacantes : null,
      renueva: (c.vence as string) || null,
      fuente: 'cuenta_activa',
    })
  }
  for (const r of renov?.items || []) {
    const t = last10(r.telefono)
    if (t.length === 10 && !map.has(t)) map.set(t, {
      empresa: (r.cuenta_nombre as string) || (r.empresa as string) || null,
      vacantes_activas: typeof r.activas === 'number' ? r.activas : null,
      renueva: (r.renueva as string) || (r.vence as string) || null,
      fuente: 'renovacion',
    })
  }
  cache = { at: Date.now(), map }
  return map
}

export async function GET(req: NextRequest) {
  const tel = last10(new URL(req.url).searchParams.get('tel'))
  if (tel.length !== 10) {
    return NextResponse.json({ es_cliente: false, motivo: 'telefono_invalido', soporte_whatsapp: SOPORTE_WA })
  }
  let hit = (await mapaClientes()).get(tel) || null

  if (!hit) {
    // CRM: leads que ya pagaron
    try {
      const supabase = createServiceClient()
      const { data } = await supabase.from('leads')
        .select('empresa, telefono, status')
        .in('status', ['convertido', 'cliente_recurrente'])
        .ilike('telefono', `%${tel}`)
        .limit(1)
      if (data && data.length) hit = { empresa: data[0].empresa || null, vacantes_activas: null, renueva: null, fuente: 'crm_convertido' }
    } catch { /* best effort */ }
  }

  return NextResponse.json({
    es_cliente: !!hit,
    empresa: hit?.empresa || null,
    vacantes_activas: hit?.vacantes_activas ?? null,
    renueva: hit?.renueva || null,
    fuente: hit?.fuente || null,
    soporte_whatsapp: SOPORTE_WA,
    instruccion: hit
      ? 'YA ES CLIENTE: no le vendas ni le ofrezcas llamada de ventas. Mándale el WhatsApp de soporte y ejecuta la alerta a soporte.'
      : 'No aparece como cliente: sigue el flujo normal de ventas (salvo que diga explícitamente que ya tiene cuenta y pida ayuda).',
  })
}

const recientes = new Map<string, number>()

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const tel = last10(body.telefono)
  if (tel.length !== 10) return NextResponse.json({ ok: false, error: 'telefono requerido' }, { status: 400 })

  const prev = recientes.get(tel)
  if (prev && Date.now() - prev < 6 * 3600_000) return NextResponse.json({ ok: true, dedupe: true })
  recientes.set(tel, Date.now())

  const hit = (await mapaClientes()).get(tel)
  const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const text = [
    ':sos: *Cliente con cuenta pidió ayuda en el WhatsApp de ventas*',
    `*Nombre:* ${clip(body.nombre, 80) || 'NA'}`,
    `*Empresa:* ${clip(body.empresa, 80) || hit?.empresa || 'NA'}`,
    `*Teléfono:* ${tel}`,
    `*Qué necesita:* ${clip(body.resumen, 400) || 'NA'}`,
    hit ? `*Cuenta:* ${hit.vacantes_activas ?? '?'} vacantes activas · renueva ${hit.renueva || '?'}` : '*Cuenta:* no la encontré por teléfono (dijo que ya es cliente)',
    body.chat ? `*Chat Vambe:* ${clip(body.chat, 200)}` : '',
    `Ya le mandamos el WhatsApp de soporte (${SOPORTE_WA}). Si no escribe ahí, contáctenlo.`,
  ].filter(Boolean).join('\n')

  const token = process.env.SLACK_BOT_TOKEN
  let ok = false
  if (token) {
    try {
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
        body: JSON.stringify({ channel: SOPORTE_CHANNEL, text }),
      })
      const j = await r.json().catch(() => null) as { ok?: boolean; error?: string } | null
      ok = !!j?.ok
      if (!ok) console.error('[vambe/cliente] slack', j?.error)
    } catch (e) { console.error('[vambe/cliente] slack', e) }
  }
  // Respaldo: si el bot no está en #tickets-soporte, mandar a #alertas-vambe
  if (!ok && process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL) {
    try {
      await fetch(process.env.SLACK_ALERTAS_VAMBE_WEBHOOK_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text + '\n_(no pude publicar en #tickets-soporte; invitar al bot del CRM a ese canal)_' }),
      })
      ok = true
    } catch { /* noop */ }
  }
  return NextResponse.json({ ok, soporte_whatsapp: SOPORTE_WA })
}
