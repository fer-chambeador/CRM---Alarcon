import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import {
  type DaptaPostCallPayload,
  type DaptaCustomAnalysis,
  normalizeDaptaStatus,
  deriveAccionables,
  extractPostCallFields,
} from '@/lib/dapta'
import { normalizeMexicanPhone } from '@/lib/phoneNormalize'
import { alertLlamadaPidioLinkPago, alertLlamadaPidioPresentacion } from '@/lib/slackAlertDapta'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/dapta/post-call?secret=<DAPTA_POST_CALL_SECRET>
 *
 * Recibe el webhook post-call de Dapta/Daniela. El payload REAL tiene TODO bajo
 * `call.*` (call_analysis, dynamic_variables.lead_id, to_number, etc.). Para
 * resiliencia, también aceptamos shape legado HubSpot (`event, call, call_analysis, data`).
 * Ver `extractPostCallFields` en `lib/dapta.ts` que centraliza la extracción.
 *
 * Estrategia de matching:
 *   1. dynamic_variables.lead_id (lo mandamos nosotros en el trigger — más confiable)
 *   2. call.call_id existente en `llamadas`
 *   3. fallback: lead por teléfono (to_number)
 *
 * Side effects:
 *   - upsert en `llamadas`
 *   - insert en `lead_actividad`
 *   - Slack alert si pidio_link_pago / pidio_presentacion
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || req.headers.get('x-dapta-secret')
  if (!process.env.DAPTA_POST_CALL_SECRET || secret !== process.env.DAPTA_POST_CALL_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const payload = await req.json().catch(() => null) as DaptaPostCallPayload | null
  if (!payload) return NextResponse.json({ error: 'invalid payload' }, { status: 400 })

  // Log defensivo: si algo falla, queremos ver el shape exacto que recibimos
  console.log('Dapta post-call payload keys:', Object.keys(payload), payload.call ? `call.keys=${Object.keys(payload.call).slice(0, 20).join(',')}` : '(no call)')

  const supabase = createServiceClient()
  const f = extractPostCallFields(payload)

  const daptaCallId = f.callId
  const toNumber = f.toNumber ? (normalizeMexicanPhone(f.toNumber) || f.toNumber) : null
  const fromNumber = f.fromNumber ? (normalizeMexicanPhone(f.fromNumber) || f.fromNumber) : null
  const customData = f.customAnalysis

  // ── 1) Resolver lead + llamada existente ──
  let llamadaId: string | null = null
  let leadId: string | null = null

  // (a) Si tenemos dapta_call_id, buscar llamada existente
  if (daptaCallId) {
    const { data: existing } = await supabase
      .from('llamadas')
      .select('id, lead_id')
      .eq('dapta_call_id', daptaCallId)
      .maybeSingle()
    if (existing) {
      llamadaId = (existing as { id: string }).id
      leadId = (existing as { lead_id: string }).lead_id
    }
  }

  // (b) Si tenemos lead_id de dynamic_variables, agarrar la llamada dialing/queued más reciente sin call_id
  if (!llamadaId && f.leadIdFromPayload) {
    leadId = f.leadIdFromPayload
    const { data: latestQueued } = await supabase
      .from('llamadas')
      .select('id')
      .eq('lead_id', f.leadIdFromPayload)
      .is('dapta_call_id', null)
      .in('status', ['dialing', 'queued'])
      .order('created_at', { ascending: false })
      .limit(1)
    if (latestQueued && latestQueued.length > 0) {
      llamadaId = (latestQueued[0] as { id: string }).id
    }
  }

  // (c) Fallback: por teléfono buscar lead Y llamada dialing/queued sin dapta_call_id
  if (!leadId && toNumber) {
    const last10 = toNumber.replace(/\D/g, '').slice(-10)
    if (last10.length === 10) {
      const { data: leadByPhone } = await supabase
        .from('leads')
        .select('id')
        .like('telefono', `%${last10}`)
        .limit(1)
      if (leadByPhone && leadByPhone.length > 0) {
        leadId = (leadByPhone[0] as { id: string }).id
      }
    }
  }

  // (d) Si tenemos leadId pero NO llamadaId, intentar matchear dialing/queued sin dapta_call_id por leadId
  if (leadId && !llamadaId) {
    const { data: existingByLead } = await supabase
      .from('llamadas')
      .select('id')
      .eq('lead_id', leadId)
      .is('dapta_call_id', null)
      .in('status', ['dialing', 'queued'])
      .order('created_at', { ascending: false })
      .limit(1)
    if (existingByLead && existingByLead.length > 0) {
      llamadaId = (existingByLead[0] as { id: string }).id
    }
  }

  // (e) último fallback: matchear por to_number en dialing/queued (caso sin lead, ej. inbound o lead borrado)
  if (!llamadaId && toNumber) {
    const last10 = toNumber.replace(/\D/g, '').slice(-10)
    if (last10.length === 10) {
      const { data: existingByPhone } = await supabase
        .from('llamadas')
        .select('id, lead_id')
        .like('to_number', `%${last10}`)
        .is('dapta_call_id', null)
        .in('status', ['dialing', 'queued'])
        .order('created_at', { ascending: false })
        .limit(1)
      if (existingByPhone && existingByPhone.length > 0) {
        const r = existingByPhone[0] as { id: string; lead_id: string | null }
        llamadaId = r.id
        if (!leadId && r.lead_id) leadId = r.lead_id
      }
    }
  }

  // ── 2) Build update/insert payload ──
  const status = normalizeDaptaStatus(f.rawStatus)
  const accionables = deriveAccionables(customData)

  const fields: Record<string, unknown> = {
    dapta_call_id: daptaCallId,
    lead_id: leadId,
    agent_id: f.agentId,
    agent_name: f.agentName || process.env.DAPTA_AGENT_NAME_DEFAULT || 'Daniela',
    status,
    to_number: toNumber,
    from_number: fromNumber,
    duration_seconds: f.durationSeconds,
    recording_url: f.recordingUrl,
    transcript: f.transcript,
    summary: f.summary,
    custom_analysis: customData,
    outcome: customData.outcome || null,
    sentimiento: customData.sentimiento || (f.userSentiment ? f.userSentiment.toLowerCase() : null),
    interes_real: customData.interes_real || null,
    pidio_link_pago: accionables.pidio_link_pago,
    pidio_presentacion: accionables.pidio_presentacion,
    agendar_seguimiento: accionables.agendar_seguimiento,
    started_at: f.startedAtIso,
    ended_at: f.endedAtIso,
  }
  // Limpiar undefined y null en columnas que tienen defaults (mantenemos null
  // explícito solo para campos que aceptan null, p.ej. recording_url)
  for (const k of Object.keys(fields)) {
    if (fields[k] === undefined) delete fields[k]
  }

  // ── 3) Upsert ──
  let savedLlamada: Record<string, unknown> | null = null
  if (llamadaId) {
    const { data: updated, error } = await supabase
      .from('llamadas')
      .update(fields)
      .eq('id', llamadaId)
      .select('*')
      .maybeSingle()
    if (error) {
      console.error('Dapta post-call update error', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    savedLlamada = (updated as Record<string, unknown>) || null
  } else {
    // No había row previa (llamada inbound o trigger directo desde Dapta sin /trigger nuestro)
    const { data: inserted, error } = await supabase
      .from('llamadas')
      .insert(fields)
      .select('*')
      .maybeSingle()
    if (error) {
      console.error('Dapta post-call insert error', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    savedLlamada = (inserted as Record<string, unknown>) || null
    llamadaId = (savedLlamada as { id?: string } | null)?.id || null
  }

  // ── 4) Lead activity log ──
  if (leadId && llamadaId) {
    await supabase.from('lead_actividad').insert({
      lead_id: leadId,
      tipo: 'dapta_call_completed',
      descripcion: buildActivityDescription(status, f.durationSeconds, customData),
      metadata: {
        source: 'dapta',
        llamada_id: llamadaId,
        dapta_call_id: daptaCallId,
        outcome: customData.outcome,
        interes: customData.interes_real,
        proximo_paso: customData.proximo_paso,
      },
    })
  }

  // ── 5) Slack alerts ──
  if (leadId && llamadaId && savedLlamada) {
    try {
      const { data: leadRow } = await supabase
        .from('leads')
        .select('id, nombre, email, empresa, telefono, presupuesto, vacante')
        .eq('id', leadId)
        .maybeSingle()
      if (leadRow) {
        const lead = leadRow as Pick<Lead, 'id' | 'nombre' | 'email' | 'empresa' | 'telefono' | 'presupuesto' | 'vacante'>
        const callSnapshot = {
          id: llamadaId,
          dapta_call_id: daptaCallId,
          duration_seconds: f.durationSeconds,
          summary: f.summary,
          recording_url: f.recordingUrl,
          custom_analysis: customData,
        }
        if (accionables.pidio_link_pago) {
          await alertLlamadaPidioLinkPago({ lead, call: callSnapshot }).catch(e => console.error('alert link pago', e))
        }
        if (accionables.pidio_presentacion) {
          await alertLlamadaPidioPresentacion({ lead, call: callSnapshot }).catch(e => console.error('alert presentacion', e))
        }
      }
    } catch (e) {
      console.error('Slack alert dispatch error', e)
    }
  }

  return NextResponse.json({ ok: true, llamada_id: llamadaId, lead_id: leadId, status })
}

function buildActivityDescription(
  status: string,
  duration: number | null,
  custom: DaptaCustomAnalysis,
): string {
  const parts: string[] = []
  if (status === 'completed') parts.push('✅ Llamada Dapta completada')
  else if (status === 'no_answer') parts.push('📵 Llamada Dapta — no contestó')
  else if (status === 'voicemail') parts.push('📬 Llamada Dapta — buzón de voz')
  else if (status === 'failed') parts.push('❌ Llamada Dapta — falló')
  else parts.push(`📞 Llamada Dapta — ${status}`)

  if (duration && duration > 0) {
    const m = Math.floor(duration / 60)
    const s = duration % 60
    parts.push(`(${m}:${s.toString().padStart(2, '0')})`)
  }
  if (custom.outcome === 'pidio_link_pago') parts.push('· 💰 PIDIÓ LIGA DE PAGO')
  else if (custom.outcome === 'pidio_presentacion') parts.push('· 📋 pidió presentación')
  else if (custom.outcome === 'no_interesado') parts.push('· no interesado')
  else if (custom.outcome === 'callback') parts.push('· pidió callback')
  if (custom.interes_real) parts.push(`· interés ${custom.interes_real}`)
  return parts.join(' ')
}
