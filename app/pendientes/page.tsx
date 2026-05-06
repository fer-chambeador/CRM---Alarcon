import { createServiceClient } from '@/lib/supabase'
import PendientesClient from '@/components/PendientesClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function PendientesPage() {
  const supabase = createServiceClient()
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })

  return <PendientesClient initialLeads={leads || []} />
}
