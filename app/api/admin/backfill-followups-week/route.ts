import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * Backfill follow_ups para llamadas Dapta de la semana 1-7 jun 2026.
 * Crea follow-ups que faltaban porque el flujo anterior solo creaba evento GCal,
 * no row en tabla follow_ups.
 *
 * Idempotente: si ya existe follow_up para ese lead con source auto_*, skip.
 * Protegido por ?secret= que matchea ADMIN_BACKFILL_SECRET o ?key= ENV.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || ''
  const expected = process.env.DAPTA_POST_CALL_SECRET || process.env.ADMIN_BACKFILL_SECRET || ''
  if (!expected || secret !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Fecha del lunes 8 jun 2026 a las 09:00 hora MX (UTC-6 = 15:00 UTC)
  const TARGET_DATE = '2026-06-08T15:00:00.000Z'

  // 1. Pull llamadas de la semana con outcomes accionables
  const since = '2026-06-01T00:00:00.000Z'
  const until = '2026-06-08T00:00:00.000Z'
  const { data: llamadas, error: llErr } = await supabase
    .from('llamadas')
    .select('id, lead_id, outcome, status, created_at, leads:leads(id, nombre, empresa, telefono, email)')
    .gte('created_at', since)
    .lt('created_at', until)
    .not('lead_id', 'is', null)
    .in('outcome', ['pidio_presentacion', 'pidio_link_pago', 'buzon_voz', 'callback'])
    .order('created_at', { ascending: false })

  if (llErr) {
    return NextResponse.json({ ok: false, error: llErr.message }, { status: 500 })
  }

  type LeadInfo = { id: string; nombre: string | null; empresa: string | null; telefono: string | null; email: string | null }
  type LlamadaRow = { id: string; lead_id: string; outcome: string; created_at: string; leads: LeadInfo | LeadInfo[] | null }
  const rows = (llamadas || []) as LlamadaRow[]

  // 2. Dedup por lead_id (tomar la más reciente)
  const byLead = new Map<string, LlamadaRow>()
  for (const r of rows) {
    if (!byLead.has(r.lead_id)) byLead.set(r.lead_id, r)
  }

  // 3. Para cada lead, chequear si ya tiene follow-up auto y crear si no
  const created: Array<{ lead_id: string; titulo: string; nombre: string | null; outcome: string }> = []
  const skipped: Array<{ lead_id: string; reason: string }> = []

  for (const r of byLead.values()) {
    const leadObj = Array.isArray(r.leads) ? r.leads[0] : r.leads
    const nombre = leadObj?.nombre || null
    const telefono = leadObj?.telefono || null
    const empresa = leadObj?.empresa || null

    // ¿Ya existe follow_up auto activo?
    const { data: exists } = await supabase
      .from('follow_ups')
      .select('id')
      .eq('lead_id', r.lead_id)
      .in('source', ['auto_presentacion', 'auto_post_call'])
      .eq('completado', false)
      .limit(1)
      .maybeSingle()
    if (exists) {
      skipped.push({ lead_id: r.lead_id, reason: 'already-has-auto-followup' })
      continue
    }

    const labelSubject = nombre || telefono || 'lead'
    let titulo = ''
    let tipo: 'presentacion' | 'pago' | 'llamada' | 'general' = 'general'
    switch (r.outcome) {
      case 'pidio_presentacion':
        titulo = `📋 Confirmar revisión de presentación — ${labelSubject}`
        tipo = 'presentacion'
        break
      case 'pidio_link_pago':
        titulo = `💰 Confirmar pago — ${labelSubject}`
        tipo = 'pago'
        break
      case 'buzon_voz':
        titulo = `📞 Reintentar llamada (fue a buzón) — ${labelSubject}`
        tipo = 'llamada'
        break
      case 'callback':
        titulo = `📅 Callback agendado — ${labelSubject}`
        tipo = 'llamada'
        break
    }

    const fechaCall = new Date(r.created_at)
    const notas = `Generado automáticamente desde llamada Dapta del ${fechaCall.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Mexico_City' })}. Outcome: ${r.outcome}${empresa ? `. Empresa: ${empresa}` : ''}.`

    const { error: insErr } = await supabase.from('follow_ups').insert({
      lead_id: r.lead_id,
      titulo,
      notas,
      fecha: TARGET_DATE,
      tipo,
      source: 'auto_post_call',
      completado: false,
    })
    if (insErr) {
      skipped.push({ lead_id: r.lead_id, reason: `insert-failed: ${insErr.message}` })
      continue
    }
    created.push({ lead_id: r.lead_id, titulo, nombre, outcome: r.outcome })
  }

  return NextResponse.json({
    ok: true,
    totalLlamadas: rows.length,
    uniqueLeads: byLead.size,
    created: created.length,
    skipped: skipped.length,
    created_items: created,
    skipped_items: skipped,
  })
}
