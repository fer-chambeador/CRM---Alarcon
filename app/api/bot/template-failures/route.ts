import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { requireBotAuth } from '../_lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bot/template-failures
 *
 * Devuelve las actividades de fallo de template más recientes con contexto del lead.
 * Útil para diagnosticar qué envíos rechazó Meta/Vambe.
 *
 * Query params:
 *   template   — filtra por nombre de template (substring)
 *   days       — ventana de días atrás (default: 30, max: 90)
 *   limit      — default 100, max 500
 *
 * Auth: header x-bot-secret
 */
export async function GET(req: NextRequest) {
  const unauth = requireBotAuth(req)
  if (unauth) return unauth

  const url = new URL(req.url)
  const template = url.searchParams.get('template')
  const days = Math.min(parseInt(url.searchParams.get('days') || '30', 10), 90)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500)

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()

  const supabase = createServiceClient()

  // Actividades de fallo
  let q = supabase
    .from('lead_actividad')
    .select('id,lead_id,tipo,descripcion,metadata,created_at')
    .in('tipo', ['bot_template_failed', 'reactivate_3d_failed', 'template_send_failed'])
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(limit)

  const { data: acts, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Filtro por template (substring en metadata.template_slug o descripción)
  const filtered = (acts || []).filter((a) => {
    if (!template) return true
    const meta = a.metadata as { template_slug?: string; template_id?: string } | null
    const slug = meta?.template_slug || ''
    const desc = a.descripcion || ''
    return slug.toLowerCase().includes(template.toLowerCase()) ||
           desc.toLowerCase().includes(template.toLowerCase())
  })

  // Join leads para dar contexto
  const leadIds = Array.from(new Set(filtered.map((a) => a.lead_id).filter(Boolean))) as string[]
  const leadsById = new Map<string, {
    id: string; nombre: string | null; empresa: string | null;
    telefono: string | null; canal_adquisicion: string | null; status: string;
  }>()

  if (leadIds.length > 0) {
    const { data: leads } = await supabase
      .from('leads')
      .select('id,nombre,empresa,telefono,canal_adquisicion,status')
      .in('id', leadIds)
    for (const l of leads || []) leadsById.set((l as { id: string }).id, l as {
      id: string; nombre: string | null; empresa: string | null;
      telefono: string | null; canal_adquisicion: string | null; status: string;
    })
  }

  const results = filtered.map((a) => {
    const meta = a.metadata as { template_slug?: string; vambe_response?: unknown; error?: string } | null
    return {
      created_at: a.created_at,
      tipo: a.tipo,
      descripcion: a.descripcion,
      template_slug: meta?.template_slug || null,
      error: meta?.error || null,
      vambe_response_hint: JSON.stringify(meta?.vambe_response || {}).slice(0, 200),
      lead: leadsById.get(a.lead_id as string) || null,
    }
  })

  return NextResponse.json({
    count: results.length,
    template_filter: template,
    days_window: days,
    failures: results,
  })
}
