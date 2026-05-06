import { Suspense } from 'react'
import { createServiceClient } from '@/lib/supabase'
import CRMClient from '@/components/CRMClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function LeadsPage() {
  const supabase = createServiceClient()
  const { data: leads } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })

  return (
    <Suspense fallback={null}>
      <CRMClient initialLeads={leads || []} />
    </Suspense>
  )
}
