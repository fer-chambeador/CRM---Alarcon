/**
 * Normaliza un teléfono a formato +52XXXXXXXXXX (México) consistente.
 *
 * Mantiene el campo `telefono` en el CRM uniforme: 12 caracteres incluyendo el "+".
 * Esto previene el bug de "no encuentro el lead por teléfono" cuando una fuente
 * (Vambe) manda 5217701836726 y otra (Slack) manda 7701836726.
 *
 * Casos manejados:
 *   "7701836726"        → "+527701836726"
 *   "5217701836726"     → "+527701836726"  (formato WhatsApp Mobile MX, quita el 1)
 *   "527701836726"      → "+527701836726"
 *   "+527701836726"     → "+527701836726"
 *   "+52 770 183 6726"  → "+527701836726"
 *   "1 (770) 183-6726"  → "+527701836726"
 *   ""                  → null
 *   "abc"               → null (no es número)
 */
export function normalizeMexicanPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null

  const cleaned = trimmed.replace(/[\s\-()+]/g, '')
  if (!/^\d+$/.test(cleaned)) return null
  const digits = cleaned

  if (digits.length === 10) return `+52${digits}`
  if (digits.length === 12 && digits.startsWith('52')) return `+${digits}`
  if (digits.length === 13 && digits.startsWith('521')) return `+52${digits.slice(3)}`
  if (digits.length === 11 && digits.startsWith('1')) return `+52${digits.slice(1)}`

  // Internacional con + (no MX): solo aceptamos si tiene >= 10 digits
  if (trimmed.startsWith('+') && digits.length >= 10) return `+${digits}`

  // Phone demasiado corto o formato no reconocido → null (no devolver basura)
  // Antes esto devolvía `trimmed` y rompía downstream con phones inválidos.
  return null
}
