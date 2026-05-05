import { createServiceClient } from '@/lib/supabase'
import AnalyticsClient from '@/components/AnalyticsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AnalyticsPage() {
  const supabase = createServiceClient()
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })

  return <AnalyticsClient initialLeads={leads || []} />
}
