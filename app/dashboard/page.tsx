import { createServiceClient } from '@/lib/supabase'
import CRMClient from '@/components/CRMClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function DashboardPage() {
  const supabase = createServiceClient()
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })

  return <CRMClient initialLeads={leads || []} />
}
