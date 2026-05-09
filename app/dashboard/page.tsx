import { redirect } from 'next/navigation'

// /dashboard se fusionó con /pendientes — redirigimos por compat de bookmarks.
export default function DashboardPage() {
  redirect('/pendientes')
}
