/**
 * One-shot: limpiar el estado de Olvera tras el bucle.
 * - Normaliza su teléfono (quita espacios)
 * - Linkea la fila 082acb75 (la real con análisis) al lead
 * - Borra la fila cc577381 (la restored que ya no necesitamos — su contenido
 *   verdadero está en 082acb75)
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
const SECRET = 'admin_cleanup_olvera_2026'

const LEAD_ID = '3d1cf3e4-2a51-497c-b3d4-9de6a99ba6d0'
const REAL_CALL_ID = '082acb75-4382-4c64-a47b-604442fb320a'  // tiene call_analysis
const DUP_CALL_ID = 'cc577381-9aaf-4841-9d7d-6b2840608c06'   // restored, vacía

export async function POST(req: NextRequest) {
  const url = new URL(req.url)
  if (url.searchParams.get('secret') !== SECRET) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const supabase = createServiceClient()
  const steps: Array<{ step: string; result: unknown }> = []

  // 1) Normalize lead phone
  const { error: phErr } = await supabase
    .from('leads')
    .update({ telefono: '+525620260608' })
    .eq('id', LEAD_ID)
  steps.push({ step: 'normalize-phone', result: phErr ? phErr.message : 'ok' })

  // 2) Link the real call to the lead
  const { error: linkErr } = await supabase
    .from('llamadas')
    .update({ lead_id: LEAD_ID })
    .eq('id', REAL_CALL_ID)
  steps.push({ step: 'link-real-call', result: linkErr ? linkErr.message : 'ok' })

  // 3) Delete the dup (restored) row
  const { error: delErr } = await supabase.from('llamadas').delete().eq('id', DUP_CALL_ID)
  steps.push({ step: 'delete-dup', result: delErr ? delErr.message : 'ok' })

  // 4) Insert lead_actividad para la llamada real (si no existe ya)
  const { data: existing } = await supabase
    .from('lead_actividad')
    .select('id')
    .eq('lead_id', LEAD_ID)
    .eq('tipo', 'dapta_call_completed')
    .contains('metadata', { llamada_id: REAL_CALL_ID })
    .limit(1)
  if (!existing || existing.length === 0) {
    const { data: callRow } = await supabase
      .from('llamadas')
      .select('outcome, duration_seconds, custom_analysis')
      .eq('id', REAL_CALL_ID)
      .maybeSingle()
    const c = (callRow as { outcome?: string; duration_seconds?: number; custom_analysis?: Record<string, unknown> } | null)
    const dur = c?.duration_seconds || 0
    const m = Math.floor(dur / 60); const s = dur % 60
    const desc = c?.outcome === 'pidio_link_pago'
      ? `✅ Llamada Dapta completada (${m}:${s.toString().padStart(2,'0')}) · 💰 PIDIÓ LIGA DE PAGO`
      : `✅ Llamada Dapta completada (${m}:${s.toString().padStart(2,'0')})`
    const { error: actErr } = await supabase.from('lead_actividad').insert({
      lead_id: LEAD_ID,
      tipo: 'dapta_call_completed',
      descripcion: desc,
      metadata: { source: 'dapta-cleanup', llamada_id: REAL_CALL_ID, outcome: c?.outcome },
    })
    steps.push({ step: 'insert-activity', result: actErr ? actErr.message : 'ok' })
  } else {
    steps.push({ step: 'insert-activity', result: 'already-exists' })
  }

  return NextResponse.json({ ok: true, steps })
}
