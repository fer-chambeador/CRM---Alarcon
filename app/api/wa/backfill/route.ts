import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, fetchAllRows } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BRIDGE_URL = (() => {
  let u = process.env.WA_BRIDGE_URL || ''
  if (u && !/^https?:\/\//.test(u)) u = 'https://' + u
  return u.replace(/\/+$/, '')
})()

function last10(v: unknown): string {
  return String(v || '').replace(/[^0-9]/g, '').slice(-10)
}

// Señales comerciales en el texto del chat (contexto: SaaS de reclutamiento).
const INTENT = /(precio|costo|cu[aá]nto|cuesta|planes?|contrat|cotiz|factura|pag(o|ar)|me interesa|interesad|quiero|demo|presentaci[oó]n|propuesta|agendar|reuni[oó]n|prueba|mensualidad|vacante|reclut)/i

type Msg = { fromMe: boolean; ts: number | null; type?: string; body: string }

function classify(msgs: Msg[]) {
  const fromMe = msgs.filter(m => m.fromMe)
  const theirs = msgs.filter(m => !m.fromMe)
  const intentMatched = msgs.some(m => INTENT.test(m.body || ''))
  const presentationSent = fromMe.some(
    m => /https?:\/\//i.test(m.body || '') || /presentaci[oó]n|propuesta|cotiz/i.test(m.body || '') || m.type === 'document',
  )
  const advanced = theirs.length >= 1 && fromMe.length >= 1
  const backAndForth = theirs.length >= 2 && fromMe.length >= 2
  const signal = intentMatched || presentationSent || backAndForth
  return {
    msgCount: msgs.length,
    fromMe: fromMe.length,
    theirs: theirs.length,
    intentMatched,
    presentationSent,
    qualifies: advanced && signal,
  }
}

/**
 * POST /api/wa/backfill  (header x-bridge-secret == WA_BRIDGE_SECRET)
 * body: {
 *   days?: number = 120,
 *   applyExisting?: boolean = true,   // actualizar leads que ya existen
 *   createUnknown?: boolean = false,  // crear leads para desconocidos que califican
 *   unknownLimit?: number = 80,       // máx. de desconocidos a analizar (transcript)
 *   onlyPhones?: string[]             // si viene: crea SOLO estos (aprobación 2da pasada)
 * }
 * Devuelve { counts, updated[], unknowns[] }.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.WA_BRIDGE_SECRET || ''
  if (!secret || req.headers.get('x-bridge-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  if (!BRIDGE_URL) return NextResponse.json({ ok: false, error: 'WA_BRIDGE_URL no configurado' })

  let body: {
    days?: number; applyExisting?: boolean; createUnknown?: boolean; unknownLimit?: number; onlyPhones?: string[]
  } = {}
  try { body = await req.json() } catch { /* defaults */ }
  const days = body.days || 120
  const applyExisting = body.applyExisting !== false
  const createUnknown = !!body.createUnknown
  const unknownLimit = Math.min(200, body.unknownLimit || 80)
  const onlyPhones = Array.isArray(body.onlyPhones) ? new Set(body.onlyPhones.map(last10)) : null

  const supabase = createServiceClient()

  // 1) chats del bridge
  const rc = await fetch(`${BRIDGE_URL}/chats?days=${days}`, { headers: { 'x-bridge-secret': secret } })
  const jc = await rc.json().catch(() => ({}))
  if (!jc?.ok) return NextResponse.json({ ok: false, error: `bridge /chats ${rc.status}`, detail: jc })
  const chats: Array<{ phone: string; name: string | null; ts: number | null; lastFromMe: boolean }> = jc.chats || []

  // 2) índice de leads por últimos 10 dígitos
  const leads = await fetchAllRows<{ id: string; telefono: string | null; status: string | null; ultimo_contacto: string | null }>(
    (from, to) => supabase.from('leads').select('id,telefono,status,ultimo_contacto').range(from, to),
  )
  const byPhone = new Map<string, { id: string; status: string | null; ultimo_contacto: string | null }>()
  for (const l of leads) {
    const d = last10(l.telefono)
    if (d.length === 10 && !byPhone.has(d)) byPhone.set(d, { id: l.id, status: l.status, ultimo_contacto: l.ultimo_contacto })
  }

  const updated: Array<Record<string, unknown>> = []
  const unknowns: Array<Record<string, unknown>> = []
  const CLOSED = new Set(['convertido', 'cliente_recurrente', 'descartado'])
  let unknownAnalyzed = 0

  for (const c of chats) {
    const d = last10(c.phone)
    if (d.length !== 10) continue
    const chatIso = c.ts ? new Date(c.ts * 1000).toISOString() : null
    const lead = byPhone.get(d)

    if (lead) {
      // Actualizar existente: nuevo->contactado + bump ultimo_contacto (sin retroceder).
      const updates: Record<string, unknown> = {}
      let newStatus = lead.status
      if (lead.status === 'nuevo') { updates.status = 'contactado'; updates.status_changed_at = new Date().toISOString(); newStatus = 'contactado' }
      if (chatIso && (!lead.ultimo_contacto || lead.ultimo_contacto < chatIso) && !CLOSED.has(String(lead.status))) {
        updates.ultimo_contacto = chatIso
      }
      if (Object.keys(updates).length === 0) continue
      if (applyExisting) {
        await supabase.from('leads').update(updates).eq('id', lead.id)
        await supabase.from('lead_actividad').insert({
          lead_id: lead.id, tipo: 'wa_backfill_sync',
          descripcion: '🔄 Sincronizado desde tu WhatsApp (backfill)',
          metadata: { source: 'wa_bridge_backfill', changes: Object.keys(updates) },
        })
      }
      updated.push({ phone: c.phone, name: c.name, oldStatus: lead.status, newStatus, ultimo_contacto: updates.ultimo_contacto || lead.ultimo_contacto, leadId: lead.id })
      continue
    }

    // Desconocido: analizar transcript (hasta unknownLimit)
    if (unknownAnalyzed >= unknownLimit) { unknowns.push({ phone: c.phone, name: c.name, skipped: 'limite' }); continue }
    unknownAnalyzed++
    let msgs: Msg[] = []
    try {
      const rm = await fetch(`${BRIDGE_URL}/chat-messages?phone=${encodeURIComponent(d)}&limit=30`, { headers: { 'x-bridge-secret': secret } })
      const jm = await rm.json().catch(() => ({}))
      msgs = (jm?.messages || []) as Msg[]
    } catch { /* sin transcript */ }
    const cl = classify(msgs)
    const snippet = msgs.slice(-4).map(m => `${m.fromMe ? 'yo' : 'ellos'}: ${(m.body || '').slice(0, 60)}`).join(' | ')
    let created = false
    const doCreate = createUnknown && (onlyPhones ? onlyPhones.has(d) : cl.qualifies)
    if (doCreate) {
      const email = `${d}@whatsapp.chambas.ai`
      const ex = await supabase.from('leads').select('id').eq('email', email).limit(1).maybeSingle()
      if (ex.data?.id) { created = false } else {
        const nowIso = new Date().toISOString()
        const ins = await supabase.from('leads').insert({
          email, telefono: c.phone, canal_adquisicion: 'WhatsApp directo',
          status: 'contactado', status_changed_at: nowIso, ultimo_contacto: chatIso || nowIso,
        }).select('id').single()
        if (!ins.error) {
          created = true
          await supabase.from('lead_actividad').insert({
            lead_id: ins.data.id, tipo: 'wa_backfill_sync',
            descripcion: '🆕 Lead creado desde tu WhatsApp (backfill, conversación calificada)',
            metadata: { source: 'wa_bridge_backfill', created: true },
          })
        }
      }
    }
    unknowns.push({ phone: c.phone, name: c.name, ...cl, created, snippet })
  }

  return NextResponse.json({
    ok: true,
    counts: {
      chats: chats.length,
      updated: updated.length,
      unknownAnalyzed,
      unknownQualifies: unknowns.filter(u => u.qualifies).length,
      created: unknowns.filter(u => u.created).length,
    },
    applyExisting, createUnknown,
    updated,
    unknowns,
  })
}
