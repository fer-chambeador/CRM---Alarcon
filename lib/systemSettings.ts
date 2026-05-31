import { createServiceClient } from './supabase'

/**
 * Key/value store de configuración del sistema, persistido en Supabase.
 * Tabla: system_settings(key text PK, value jsonb, updated_at timestamptz)
 *
 * Settings actuales:
 *   - 'vambe_outbound_template': { template_id, template_name }
 *     → Plantilla que se usa para el flujo Outbound Vambe (Phase 92).
 *       Fallback: env VAMBE_AGENDA_TEMPLATE_ID si no hay row.
 */

export type SystemSettings = {
  vambe_outbound_template?: {
    template_id: string
    template_name: string
  }
}

type Supabase = ReturnType<typeof createServiceClient>

export async function getSetting<K extends keyof SystemSettings>(
  supabase: Supabase, key: K,
): Promise<SystemSettings[K] | null> {
  const { data } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle()
  return (data as { value: SystemSettings[K] } | null)?.value || null
}

export async function setSetting<K extends keyof SystemSettings>(
  supabase: Supabase, key: K, value: SystemSettings[K],
): Promise<void> {
  await supabase
    .from('system_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
}

/**
 * Resuelve el template_id de Outbound Vambe — DB > env var > null.
 */
export async function getOutboundTemplate(supabase: Supabase): Promise<{ template_id: string; template_name: string } | null> {
  const fromDb = await getSetting(supabase, 'vambe_outbound_template')
  if (fromDb?.template_id) return fromDb
  if (process.env.VAMBE_AGENDA_TEMPLATE_ID) {
    return {
      template_id: process.env.VAMBE_AGENDA_TEMPLATE_ID,
      template_name: 'outbound_primer_mensaje_sales',
    }
  }
  return null
}
