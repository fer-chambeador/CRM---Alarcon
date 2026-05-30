import LeadDetailClient from '@/components/LeadDetailClient'

export const dynamic = 'force-dynamic'

export default function LeadDetailPage({ params }: { params: { id: string } }) {
  return <LeadDetailClient leadId={params.id} />
}
