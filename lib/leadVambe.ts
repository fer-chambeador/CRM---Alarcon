import type { Lead } from './supabase'

/**
 * Helpers para identificar leads de Vambe y su elegibilidad para
 * el botón "Reactivar Vambe >3d" en CRM.
 *
 * Compartido entre LeadDetailClient (/leads/[id]) y LeadModal
 * (en /leads). El endpoint /api/leads/[id]/reactivate-vambe-3d
 * re-aplica la misma validación server-side.
 */

/**
 * ¿Este lead vino por Vambe / WhatsApp?
 * - vambe_contact_id no null → ya tiene contacto en Vambe (lo más seguro)
 * - canal_adquisicion contiene 'vambe' o 'whatsapp' → fallback por canal
 */
export function isVambeLead(lead: Pick<Lead, 'vambe_contact_id' | 'canal_adquisicion'>): boolean {
  if (lead.vambe_contact_id) return true
  const canal = (lead.canal_adquisicion || '').toLowerCase()
  return canal.includes('vambe') || canal.includes('whatsapp')
}

/**
 * Días transcurridos desde `ultimo_contacto`. Null si nunca contactado.
 * Devuelve días con decimales (ej. 3.4) — los consumidores deciden si
 * comparar con >= 3 o redondear.
 */
export function daysSinceContact(lead: Pick<Lead, 'ultimo_contacto'>): number | null {
  if (!lead.ultimo_contacto) return null
  const ms = Date.now() - new Date(lead.ultimo_contacto).getTime()
  return ms / 86_400_000
}

/**
 * ¿El lead es elegible para el botón "Reactivar Vambe >3d"?
 *  - Es lead de Vambe (canal o vambe_contact_id)
 *  - Tiene teléfono (para enviar)
 *  - ultimo_contacto >= 3 días (o null = nunca contactado, dejamos pasar)
 *  - Status no terminal (descartado, convertido, recurrente)
 *
 * El endpoint server-side re-valida lo mismo.
 */
export function canReactivateVambe3d(lead: Pick<Lead, 'vambe_contact_id' | 'canal_adquisicion' | 'ultimo_contacto' | 'telefono' | 'status'>): boolean {
  if (!isVambeLead(lead)) return false
  if (!lead.telefono) return false
  // Status terminal — no tiene sentido reactivar
  const TERMINAL: Lead['status'][] = ['descartado', 'convertido', 'cliente_recurrente']
  if (TERMINAL.includes(lead.status)) return false
  // Días: null → nunca contactado → dejar pasar. Si tiene fecha, exigir >=3
  const d = daysSinceContact(lead)
  if (d !== null && d < 3) return false
  return true
}
