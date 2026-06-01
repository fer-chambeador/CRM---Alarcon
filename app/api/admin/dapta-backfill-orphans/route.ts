/**
 * POST /api/admin/dapta-backfill-orphans?secret=admin_dapta_backfill_2026
 *
 * Encuentra llamadas con `lead_id=NULL` (orphans) que tienen `to_number` set,
 * busca el lead correspondiente por phone last10 y las re-vincula. Útil cuando
 * el post-call llegó antes de que `dynamic_variables.lead_id` estuviera bien
 * configurado en Dapta, o cuando hay un bug en el handler que no matchea bien.
 *
 * También inserta el lead_actividad correspondiente y dispara las alertas Slack
 * (link de pago / presentación) que se hayan perdido.
 *
 * Devuelve: { ok, scanned, fixed, errors, details: [...] }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { alertLlamadaPidioLinkPago, alertLlamadaPidioPresentacion } from '@/lib/slackAlertDapta'

export const dynamic = 'force-dynamic'

const ADMIN_SECRET = 'admin_dapta_backfill_2026'

type Llamada = {
  id: string
  dapta_call_id: string | null
  lead_id: string | null
  to_number: string | null
  status: string | null
  duration_seconds: number | null
  summary: string | null
  recording_url: string | null
  custom_analysis: Record<string, unknown> | null
  outcome: string | null
  pidio_link_pago: boolean | null
  pidio_presentacion: boolean | null
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (secret !== ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // Pick up orphans: completed sin lead_id pero con to_number — últimos 7 días
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: orphans, error: orphansErr } = await supabase
    .from('llamadas')
    .select('id, dapta_call_id, lead_id, to_number, status, duration_seconds, summary, recording_url, custom_analysis, outcome, pidio_link_pago, pidio_presentacion')
    .is('lead_id', null)
    .not('to_number', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50)

  if (orphansErr) {
    return NextResponse.json({ error: orphansErr.message }, { status: 500 })
  }

  const list = (orphans || []) as Llamada[]
  let fixed = 0
  const details: Array<{ llamada_id: string; result: string; lead_id?: string | null }> = []

  for (const l of list) {
    const last10 = (l.to_number || '').replace(/\D/g, '').slice(-10)
    if (last10.length < 10) {
      details.push({ llamada_id: l.id, result: 'skip-short-phone' })
      continue
    }
    const { data: leadRows } = await supabase
      .from('leads')
      .select('id, nombre, email, empresa, telefono, presupuesto, vacante')
      .like('telefono', `%${last10}`)
      .limit(1)
    if (!leadRows || leadRows.length === 0) {
      details.push({ llamada_id: l.id, result: 'no-lead-found' })
      continue
    }
    const lead = leadRows[0] as Pick<Lead, 'id' | 'nombre' | 'email' | 'empresa' | 'telefono' | 'presupuesto' | 'vacante'>

    // Update llamada con lead_id
    const { error: updErr } = await supabase
      .from('llamadas')
      .update({ lead_id: lead.id })
      .eq('id', l.id)
    if (updErr) {
      details.push({ llamada_id: l.id, result: `error: ${updErr.message}` })
      continue
    }

    // Insert lead_actividad si no existe ya uno para esta llamada
    const { data: existingAct } = await supabase
      .from('lead_actividad')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('tipo', 'dapta_call_completed')
      .contains('metadata', { llamada_id: l.id })
      .limit(1)
    if (!existingAct || existingAct.length === 0) {
      const dur = l.duration_seconds || 0
      const m = Math.floor(dur / 60)
      const s = dur % 60
      const desc = l.outcome === 'pidio_link_pago'
        ? `✅ Llamada Dapta completada (${m}:${s.toString().padStart(2,'0')}) · 💰 PIDIÓ LIGA DE PAGO`
        : l.outcome === 'pidio_presentacion'
        ? `✅ Llamada Dapta completada (${m}:${s.toString().padStart(2,'0')}) · 📋 pidió presentación`
        : `✅ Llamada Dapta completada (${m}:${s.toString().padStart(2,'0')})`
      await supabase.from('lead_actividad').insert({
        lead_id: lead.id,
        tipo: 'dapta_call_completed',
        descripcion: desc,
        metadata: {
          source: 'dapta-backfill',
          llamada_id: l.id,
          dapta_call_id: l.dapta_call_id,
          outcome: l.outcome,
        },
      })
    }

    // Slack alerts si los flags están y no se mandaron antes
    const call = {
      id: l.id,
      dapta_call_id: l.dapta_call_id,
      duration_seconds: l.duration_seconds,
      summary: l.summary,
      recording_url: l.recording_url,
      custom_analysis: (l.custom_analysis || {}) as Record<string, unknown>,
    }
    if (l.pidio_link_pago) {
      await alertLlamadaPidioLinkPago({ lead, call }).catch(e => console.error('backfill alert link', e))
    }
    if (l.pidio_presentacion) {
      await alertLlamadaPidioPresentacion({ lead, call }).catch(e => console.error('backfill alert pres', e))
    }

    fixed++
    details.push({ llamada_id: l.id, result: 'fixed', lead_id: lead.id })
  }

  return NextResponse.json({
    ok: true,
    scanned: list.length,
    fixed,
    details,
  })
}

// GET para listar orphans sin tocar nada (debug)
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (secret !== ADMIN_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const supabase = createServiceClient()
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('llamadas')
    .select('id, dapta_call_id, to_number, status, outcome, duration_seconds, created_at')
    .is('lead_id', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ count: data?.length || 0, llamadas: data || [] })
}
