import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/debug/lead-info?phone=XXXX&secret=...
 * GET /api/debug/lead-info?email=XXX&secret=...
 * GET /api/debug/lead-info?contact_id=XXX&secret=...
 *
 * Devuelve TODO lo que sabemos de un lead: si está en `leads`, en
 * `vambe_pending_leads`, los últimos webhooks recibidos para su aiContactId,
 * y su actividad.
 *
 * Útil para diagnosticar por qué un lead específico no aparece en el CRM.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!process.env.VAMBE_WEBHOOK_SECRET || secret !== process.env.VAMBE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const phone = url.searchParams.get('phone')
  const email = url.searchParams.get('email')
  const contactId = url.searchParams.get('contact_id')

  if (!phone && !email && !contactId) {
    return NextResponse.json({ error: 'pasá phone, email o contact_id' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const result: Record<string, unknown> = {
    query: { phone, email, contact_id: contactId },
    in_leads: null,
    leads_by_phone_last10: [],
    in_pending: null,
    webhook_log_recent: [],
    activity_recent: [],
  }

  // 1. Buscar en leads — por email, contact_id, phone (last 10)
  if (email) {
    const { data } = await supabase.from('leads').select('*').ilike('email', email).maybeSingle()
    if (data) result.in_leads = data
  }
  if (!result.in_leads && contactId) {
    const { data } = await supabase.from('leads').select('*').eq('vambe_contact_id', contactId).maybeSingle()
    if (data) result.in_leads = data
  }
  if (!result.in_leads && phone) {
    const last10 = phone.replace(/\D/g, '').slice(-10)
    const { data } = await supabase.from('leads').select('*').like('telefono', `%${last10}`)
    if (data && data.length > 0) {
      result.in_leads = data[0]
      result.leads_by_phone_last10 = data
    }
  }

  // 2. Buscar en pending — por contact_id o intento por email/phone en form_data
  if (contactId) {
    const { data } = await supabase.from('vambe_pending_leads').select('*').eq('vambe_contact_id', contactId).maybeSingle()
    if (data) result.in_pending = data
  }
  if (!result.in_pending && email) {
    // Form_data is JSONB — usar contains
    const { data } = await supabase.from('vambe_pending_leads').select('*')
      .filter('form_data->>email', 'ilike', email)
      .limit(1)
    if (data && data.length > 0) result.in_pending = data[0]
  }
  if (!result.in_pending && phone) {
    const last10 = phone.replace(/\D/g, '').slice(-10)
    const { data } = await supabase.from('vambe_pending_leads').select('*')
      .filter('form_data->>telefono', 'like', `%${last10}`)
      .limit(1)
    if (data && data.length > 0) result.in_pending = data[0]
  }

  // 3. Webhook log recientes — por contact_id o búsqueda en payload
  const effectiveContactId = contactId
    || (result.in_leads as { vambe_contact_id?: string } | null)?.vambe_contact_id
    || (result.in_pending as { vambe_contact_id?: string } | null)?.vambe_contact_id
  if (effectiveContactId) {
    try {
      const { data } = await supabase.from('vambe_webhook_log')
        .select('event_type, ai_contact_id, payload, received_at')
        .eq('ai_contact_id', effectiveContactId)
        .order('received_at', { ascending: false })
        .limit(15)
      result.webhook_log_recent = data || []
    } catch { /* tabla no existe aún */ }
  }
  if ((result.webhook_log_recent as unknown[]).length === 0 && phone) {
    // Buscar en payload del log por teléfono
    try {
      const last10 = phone.replace(/\D/g, '').slice(-10)
      const { data } = await supabase.from('vambe_webhook_log')
        .select('event_type, ai_contact_id, payload, received_at')
        .or(`payload->>phone.ilike.%${last10}%,payload->>telefono.ilike.%${last10}%`)
        .order('received_at', { ascending: false })
        .limit(15)
      result.webhook_log_recent = data || []
    } catch { /* skip */ }
  }

  // 4. Actividad reciente del lead (si está en leads)
  const leadId = (result.in_leads as { id?: string } | null)?.id
  if (leadId) {
    const { data } = await supabase.from('lead_actividad')
      .select('tipo, descripcion, created_at')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(15)
    result.activity_recent = data || []
  }

  // 5. Resumen ejecutivo
  result.summary = {
    is_in_crm: !!result.in_leads,
    is_in_pending: !!result.in_pending,
    webhook_events_seen: (result.webhook_log_recent as unknown[]).length,
    diagnosis: !result.in_leads && !result.in_pending && (result.webhook_log_recent as unknown[]).length === 0
      ? '❌ Lead no existe en CRM, ni en pending, ni hay eventos webhook → Vambe NO está pegando al webhook para este contacto'
      : !result.in_leads && (result.in_pending || (result.webhook_log_recent as unknown[]).length > 0)
        ? '⚠️ Lead llegó al webhook/pending pero no se promovió al CRM → bug en promoción'
        : result.in_leads
          ? '✅ Lead está en CRM'
          : '?',
  }

  return NextResponse.json(result)
}
