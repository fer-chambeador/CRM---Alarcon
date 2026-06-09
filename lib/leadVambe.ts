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
 * ¿Este lead vino por Vambe?
 * Validación estricta: SOLO leads con canal_adquisicion = "Vambe" (case-insensitive)
 * son elegibles para el botón Reactivar Vambe >3d. El template de WhatsApp
 * `reactivacion_3d_chambasai` está aprobado por Meta para este caso de uso
 * específico — leads que llegaron originalmente vía Vambe (formulario Meta ads
 * → conversación AI). NO se dispara a leads de Slack, Instagram, manual, etc.
 *
 * Antes incluía OR con `vambe_contact_id` y `canal_adquisicion contiene whatsapp`,
 * pero eso era demasiado laxo. Fer aclaró (8-jun-2026): "esa plantilla solo se
 * puede detonar a leads que vengan de Vambe".
 */
export function isVambeLead(lead: Pick<Lead, 'canal_adquisicion'>): boolean {
  const canal = (lead.canal_adquisicion || '').toLowerCase()
  return canal.includes('vambe')
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
export function canReactivateVambe3d(lead: Pick<Lead, 'canal_adquisicion' | 'ultimo_contacto' | 'telefono' | 'status'>): boolean {
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
