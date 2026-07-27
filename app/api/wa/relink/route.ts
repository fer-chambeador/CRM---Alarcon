import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// GET /api/wa/relink — proxy server-side: fuerza al bridge a borrar su sesión
// y reiniciar para generar un QR nuevo. Usa el secret del servidor (no expuesto).
// Endpoint temporal de recuperación; quitar tras re-vincular.
export async function GET() {
  const secret = process.env.WA_BRIDGE_SECRET || ''
  let u = process.env.WA_BRIDGE_URL || ''
  if (u && !/^https?:\/\//.test(u)) u = 'https://' + u
  u = u.replace(/\/+$/, '')
  if (!u || !secret) return NextResponse.json({ ok: false, error: 'WA_BRIDGE no configurado' })
  try {
    const r = await fetch(`${u}/relink`, { method: 'POST', headers: { 'x-bridge-secret': secret } })
    const t = await r.text()
    return NextResponse.json({ ok: true, status: r.status, body: t.slice(0, 200) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'error' })
  }
}
