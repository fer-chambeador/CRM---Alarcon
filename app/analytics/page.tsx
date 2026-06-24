import { createServiceClient, fetchAllRows, type Lead } from '@/lib/supabase'
import AnalyticsClient from '@/components/AnalyticsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AnalyticsPage() {
  const supabase = createServiceClient()
  // BUG FIX (23-jun-2026): Supabase default capa a 1000 rows. Con >1000 leads
  // en BD, el chart "Por día" no veía los días más viejos del periodo
  // (ej. 1-6 jun ausentes porque eran descartados al pasarse del cap).
  // fetchAllRows pagina automáticamente — mismo patrón que /leads/page.tsx.
  const leads = await fetchAllRows<Lead>((from, to) =>
    supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to),
  )

  return <AnalyticsClient initialLeads={leads} />
}
