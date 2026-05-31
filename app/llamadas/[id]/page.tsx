import LlamadaDetailClient from '@/components/LlamadaDetailClient'

export const dynamic = 'force-dynamic'

export default function LlamadaDetailPage({ params }: { params: { id: string } }) {
  return <LlamadaDetailClient id={params.id} />
}
