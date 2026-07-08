/**
 * Cliente del "WA Bridge" — microservicio (carpeta wa-bridge/ en este repo)
 * que se vincula al WhatsApp de Fer como dispositivo (QR, igual que WhatsApp
 * Web) y permite mandar mensajes REALES desde su número, disparados 1×1
 * desde el CRM con el popup del botón Mensaje.
 *
 * Env vars (Railway → servicio CRM):
 *   WA_BRIDGE_URL     p.ej. https://wa-bridge-production.up.railway.app
 *   WA_BRIDGE_SECRET  secreto compartido — mismo valor que en el bridge
 */

// Mismo copy que la plantilla Vambe `outbound_primer_mensaje_sales`.
// ⚠️ Si esa plantilla cambia en Vambe, actualizar aquí también.
export const waDirectTemplate = (empresa: string) =>
  `Lic, mucho gusto. Soy Fernando de ChambasAI, la plataforma para reclutar personal, vi que te registraste con ${empresa}.\n\n¿Estás libre hoy o mañana para una llamada? Así te explico a detalle cómo reclutamos.`

export type WaBridgeResult = { ok: boolean; error?: string; to?: string }

export async function sendViaWaBridge(phone: string, text: string): Promise<WaBridgeResult> {
  const base = process.env.WA_BRIDGE_URL
  const secret = process.env.WA_BRIDGE_SECRET
  if (!base || !secret) {
    return { ok: false, error: 'WA Bridge no configurado (faltan WA_BRIDGE_URL / WA_BRIDGE_SECRET)' }
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-secret': secret },
      body: JSON.stringify({ phone, text }),
      signal: AbortSignal.timeout(25_000),
    })
    const data = await res.json().catch(() => ({})) as WaBridgeResult
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `bridge respondió HTTP ${res.status}` }
    return data
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
