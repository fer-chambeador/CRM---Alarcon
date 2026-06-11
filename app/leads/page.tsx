import { Suspense } from 'react'
import { createServiceClient, fetchAllRows, type Lead } from '@/lib/supabase'
import CRMClient from '@/components/CRMClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function LeadsPage() {
  const supabase = createServiceClient()
  // fetchAllRows pagina de a 1000 — sin esto Supabase capa la respuesta
  // a 1000 filas y el CRM "pierde" leads silenciosamente.
  const leads = await fetchAllRows<Lead>((from, to) =>
    supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, to),
  )

  return (
    <Suspense fallback={null}>
      <CRMClient initialLeads={leads} />
    </Suspense>
  )
}
