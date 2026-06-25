import { createServiceClient, fetchAllRows, type Lead } from '@/lib/supabase'
import { listTemplates } from '@/lib/vambe'
import OutboundClient, { type OutboundLead, type OutboundTemplate } from '@/components/OutboundClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function OutboundPage() {
  const supabase = createServiceClient()

  // Cargar TODOS los leads (sin cap de 1000) — el filtro se hace en cliente
  // para que Fer pueda combinar libremente.
  const leads = await fetchAllRows<Lead>((from, to) =>
    supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to),
  )

  // Mapeo mínimo para mandar al client (no exponer columnas sensibles)
  const slim: OutboundLead[] = leads.map((l) => ({
    id: l.id,
    nombre: l.nombre,
    email: l.email,
    telefono: l.telefono,
    status: l.status,
    empresa: l.empresa,
    vacante: l.vacante,
    canal_adquisicion: l.canal_adquisicion,
    created_at: l.created_at,
    ultimo_contacto: l.ultimo_contacto ?? null,
    vambe_contact_id: (l as Lead & { vambe_contact_id?: string }).vambe_contact_id ?? null,
    vambe_stage_id: (l as Lead & { vambe_stage_id?: string }).vambe_stage_id ?? null,
  }))

  // Cargar plantillas Vambe — pedimos TODAS y filtramos en código por
  // status='approved' (case-insensitive). Antes mandábamos los filtros como
  // query params al API de Vambe (status=APPROVED + channel_type=whatsapp)
  // pero eso devolvía 0 resultados en producción (la API parece esperar
  // valores distintos a los documentados). Hacer el filtro acá es más
  // resiliente y deja log visible si la lista sigue vacía.
  let templates: OutboundTemplate[] = []
  try {
    const res = await listTemplates({ get_all: true })
    const all = res.templates
    const approved = all.filter((t) => {
      const s = String((t as { status?: string }).status || '').toLowerCase()
      // Si Vambe no devuelve campo status, asumimos APPROVED (porque para enviar
      // una plantilla via API debe estar aprobada — Vambe rechazaría sino).
      return !s || s.includes('approv')
    })
    templates = approved.map((t) => ({
      id: String(t.id || ''),
      name: String(t.name || ''),
      preview: String(
        (t as { body?: string; content?: string; text?: string; components?: unknown[] }).body
        || (t as { content?: string }).content
        || (t as { text?: string }).text
        || extractBodyFromComponents((t as { components?: unknown[] }).components)
        || '',
      ),
      category: String((t as { category?: string }).category || ''),
    })).filter((t) => t.id && t.name)
    console.log(`[outbound] templates loaded: ${all.length} total, ${approved.length} approved, ${templates.length} valid`)
  } catch (e) {
    console.error('Outbound: listTemplates falló', e)
  }

  return <OutboundClient initialLeads={slim} initialTemplates={templates} />
}

// Vambe a veces devuelve el body dentro de `components: [{ type: 'BODY', text: '...' }]`
// (formato Meta WhatsApp Business). Lo extraemos para preview.
function extractBodyFromComponents(components: unknown): string {
  if (!Array.isArray(components)) return ''
  for (const c of components as Array<Record<string, unknown>>) {
    const type = String(c?.type || '').toUpperCase()
    if (type === 'BODY' || type === 'TEXT') {
      const text = c?.text || c?.content || c?.body
      if (typeof text === 'string') return text
    }
  }
  return ''
}
