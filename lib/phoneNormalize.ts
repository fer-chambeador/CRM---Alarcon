/**
 * Normaliza un teléfono a formato +52XXXXXXXXXX (México) consistente.
 *
 * Mantiene el campo `telefono` en el CRM uniforme: 12 caracteres incluyendo el "+".
 * Esto previene el bug de "no encuentro el lead por teléfono" cuando una fuente
 * (Vambe) manda 5217701836726 y otra (Slack) manda 7701836726.
 *
 * Casos manejados:
 *   "7701836726"            → "+527701836726"
 *   "5217701836726"         → "+527701836726"  (formato WhatsApp Mobile MX, quita el 1)
 *   "527701836726"          → "+527701836726"
 *   "+527701836726"         → "+527701836726"
 *   "+52 770 183 6726"      → "+527701836726"
 *   "1 (770) 183-6726"      → "+527701836726"
 *   "+5201 55 2902 9164"    → "+525529029164" (formato MX viejo con prefijo LD "01")
 *   "52015529029164"        → "+525529029164" (mismo, sin "+")
 *   ""                      → null
 *   "abc"                   → null (no es número)
 *
 * BUG FIX (2 jun 2026): se agregó el caso `5201XXXXXXXXXX` (14 dígitos
 * empezando con "5201"). Ejemplos vistos en producción: Vambe importó leads
 * con el formato viejo MX "+52 01 55 2902 9164" (donde "01" es el prefijo
 * de larga distancia nacional). Antes nuestro normalizer dejaba pasar ese
 * número como "+52015529029164" y Dapta lo rechazaba/no marcaba → la fila
 * quedaba stuck en "dialing" (caso Yanelli + Petrus). Ahora reconocemos y
 * limpiamos el "01" entre el "52" y los últimos 10 dígitos del celular.
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

  // Formato MX viejo con prefijo de larga distancia nacional "01":
  //   "+52 01 55 2902 9164" → quitamos "01" entre el "52" y el celular.
  // Acepta 14 dígitos starting con "5201" → "+52" + últimos 10.
  if (digits.length === 14 && digits.startsWith('5201')) return `+52${digits.slice(4)}`

  // Variante: 15 dígitos con "52" + "01" + "1" (LD + celular MX viejo).
  //   "+52 01 1 55 2902 9164" → 15 dígitos starting "52011"
  if (digits.length === 15 && digits.startsWith('52011')) return `+52${digits.slice(5)}`

  // Internacional con + (no MX): solo aceptamos si tiene >= 10 digits
  if (trimmed.startsWith('+') && digits.length >= 10) return `+${digits}`

  // Phone demasiado corto o formato no reconocido → null (no devolver basura)
  // Antes esto devolvía `trimmed` y rompía downstream con phones inválidos.
  return null
}
