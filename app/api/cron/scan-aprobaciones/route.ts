import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import type { Lead } from '@/lib/supabase'
import { leadScore } from '@/lib/scoring'
import {
  isVambeTemplateCandidate,
  isDaptaCallCandidate,
  defaultExpiresAt,
  VAMBE_AGENDA_TEMPLATE_NAME,
} from '@/lib/aprobaciones'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/cron/scan-aprobaciones?secret=<CRON_SECRET|DAPTA_POST_CALL_SECRET>
 *
 * Disparado por cron-job.org cada 15 min. Escanea leads y crea filas pending
 * en `aprobaciones` para los candidates. Idempotente (UNIQUE constraint).
 *
 * Lo que detecta:
 *  - Vambe template: lead.status='nuevo' AND created_at <= now()-30min AND score < 60
 *    AND NO hay aprobación previa (pending/approved/rejected/failed) del mismo tipo.
 *  - Dapta call: lead.status='llamada_agendada' AND llamada_at > now()+5min AND score < 60
 *    AND NO hay aprobación previa del mismo tipo.
 *
 * "No hay aprobación previa" significa: no preguntamos de nuevo si ya lo
 * decidiste antes (aunque hayas dicho 'rejected_manual').
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || req.headers.get('x-cron-secret')
  const expected = process.env.CRON_SECRET || process.env.DAPTA_POST_CALL_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const created: Array<{ tipo: string; lead_id: string; reason: string }> = []
  const skipped: Array<{ lead_id: string; reason: string }> = []

  // Pull leads candidatos. Solo los 2 status que nos interesan + created últimos 30 días.
  const since30d = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .in('status', ['nuevo', 'llamada_agendada'])
    .gte('created_at', since30d)
    .limit(500)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Pull aprobaciones existentes (cualquier status) para los leads — para no recrear.
  const leadIds = (leads || []).map(l => (l as Lead).id)
  const { data: existing } = await supabase
    .from('aprobaciones')
    .select('lead_id, tipo, status')
    .in('lead_id', leadIds.length > 0 ? leadIds : ['00000000-0000-0000-0000-000000000000'])

  // Key = `${lead_id}:${tipo}` — si existe, skipear.
  const seen = new Set<string>()
  for (const e of (existing || []) as Array<{ lead_id: string; tipo: string; status: string }>) {
    seen.add(`${e.lead_id}:${e.tipo}`)
  }

  // Template ID de Vambe (env). Si no existe, igual creamos la aprobación pero
  // con template_id=null — al aprobar va a fallar hasta que el user lo configure.
  const vambeTemplateId = process.env.VAMBE_AGENDA_TEMPLATE_ID || null

  const VAMBE_TIPO = 'vambe_template'
  const DAPTA_TIPO = 'dapta_call'

  for (const raw of (leads || []) as Lead[]) {
    const lead = raw
    const ageMin = (Date.now() - new Date(lead.created_at).getTime()) / 60_000
    const score = leadScore(lead)

    // ── Vambe candidate ──
    if (lead.status === 'nuevo' && !seen.has(`${lead.id}:${VAMBE_TIPO}`)) {
      const check = isVambeTemplateCandidate(lead, ageMin)
      if (check.candidate) {
        const { error: insErr } = await supabase.from('aprobaciones').insert({
          tipo: VAMBE_TIPO,
          lead_id: lead.id,
          status: 'pending',
          template_id: vambeTemplateId,
          template_name: VAMBE_AGENDA_TEMPLATE_NAME,
          reason: check.reason,
          score_snapshot: score,
          expires_at: defaultExpiresAt(VAMBE_TIPO, lead),
        })
        if (!insErr) {
          created.push({ tipo: VAMBE_TIPO, lead_id: lead.id, reason: check.reason })
          seen.add(`${lead.id}:${VAMBE_TIPO}`)
        } else if (insErr.code !== '23505') {
          // 23505 = unique violation (race con otro cron run) — ignorar
          skipped.push({ lead_id: lead.id, reason: `insert error: ${insErr.message}` })
        }
      } else {
        skipped.push({ lead_id: lead.id, reason: `vambe: ${check.reason}` })
      }
    }

    // ── Dapta candidate ──
    if (lead.status === 'llamada_agendada' && !seen.has(`${lead.id}:${DAPTA_TIPO}`)) {
      const check = isDaptaCallCandidate(lead)
      if (check.candidate) {
        const { error: insErr } = await supabase.from('aprobaciones').insert({
          tipo: DAPTA_TIPO,
          lead_id: lead.id,
          status: 'pending',
          scheduled_at: lead.llamada_at,
          reason: check.reason,
          score_snapshot: score,
          expires_at: defaultExpiresAt(DAPTA_TIPO, lead),
        })
        if (!insErr) {
          created.push({ tipo: DAPTA_TIPO, lead_id: lead.id, reason: check.reason })
          seen.add(`${lead.id}:${DAPTA_TIPO}`)
        } else if (insErr.code !== '23505') {
          skipped.push({ lead_id: lead.id, reason: `dapta: ${insErr.message}` })
        }
      } else {
        skipped.push({ lead_id: lead.id, reason: `dapta: ${check.reason}` })
      }
    }
  }

  // Expirar aprobaciones cuyo expires_at ya pasó. El chain update().select()
  // devuelve los rows actualizados; contamos la longitud para el reporte.
  const now = new Date().toISOString()
  const { data: expiredRows } = await supabase
    .from('aprobaciones')
    .update({ status: 'expired', decided_at: now })
    .eq('status', 'pending')
    .lt('expires_at', now)
    .select('id')
  const expiredCount = (expiredRows || []).length

  return NextResponse.json({
    ok: true,
    timestamp: now,
    leads_scanned: (leads || []).length,
    created: created.length,
    expired: expiredCount,
    details: { created, skipped: skipped.slice(0, 50) },
  })
}
