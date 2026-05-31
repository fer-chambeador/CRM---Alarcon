import { redirect } from 'next/navigation'

// Redirect del URL viejo al nuevo. Mantenemos para que cualquier bookmark
// o link interno siga funcionando.
export default function AprobacionesRedirect() {
  redirect('/outbound')
}
