/**
 * POST /api/outbound/dispatch
 *
 * Recibe un batch de leads y dispara la plantilla Vambe a cada uno.
 * Procesa en serie (con pequeño throttle interno) para no abusar de Vambe.
 *
 * Body:
 *  {
 *    templateId: string  // UUID de la plantilla Vambe (debe estar APPROVED)
 *    stageId?: string    // UUID del stage destino (si vacío, no mueve)
 *    leads: { id: string; phone: string }[]
 *  }
 *
 * Response:
 *  {
 *    results: { id: string; ok: boolean; messageId?: string; error?: string }[]
 *  }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { sendTemplate } from '@/lib/vambe'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type DispatchBody = {
  templateId?: string
  stageId?: string
  leads?: { id: string; phone: string | null }[]
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as DispatchBody | null
  if (!body || !body.templateId || !Array.isArray(body.leads)) {
    return NextResponse.json({ error: 'invalid-body' }, { status: 400 })
  }

  const { templateId, stageId, leads } = body
  if (leads.length === 0) {
    return NextResponse.json({ results: [] })
  }
  if (leads.length > 100) {
    return NextResponse.json({ error: 'batch-too-large (max 100)' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const results: { id: string; ok: boolean; messageId?: string; error?: string }[] = []

  for (const l of leads) {
    if (!l.phone) {
      results.push({ id: l.id, ok: false, error: 'no-phone' })
      continue
    }
    try {
      const r = (await sendTemplate({
        phone: l.phone,
        templateId,
        stageId: stageId || undefined,
      })) as { messageId?: string; contactId?: string }

      // Registrar la actividad para no re-mandarle al mismo lead la próxima
      // vez que Fer haga una campaña (bumpea ultimo_contacto vía RPC atómica).
      await supabase.from('lead_actividad').insert({
        lead_id: l.id,
        tipo: 'outbound_bulk_sent',
        descripcion: `📨 Plantilla enviada vía Outbound masivo`,
        metadata: { template_id: templateId, stage_id: stageId || null, vambe_message_id: r.messageId, vambe_contact_id: r.contactId },
      }).then(() => null).catch((e) => { console.warn('actividad insert falló', e) })

      await supabase.rpc('bump_lead_contacto', {
        p_lead_id: l.id,
        p_set_contactado: false, // no forzar nuevo→contactado; el bot Vambe lo moverá
      }).then(() => null).catch((e) => { console.warn('bump_lead_contacto falló', e) })

      results.push({ id: l.id, ok: true, messageId: r.messageId })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ id: l.id, ok: false, error: msg.slice(0, 200) })
    }
    // pequeño throttle para no martillar Vambe (200ms entre envíos)
    await new Promise((r) => setTimeout(r, 200))
  }

  return NextResponse.json({ results })
}
