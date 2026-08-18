export const fetchCache = 'force-no-store';
import { NextResponse } from 'next/server'; export const dynamic = 'force-dynamic'; export async function GET(req: Request) {
  const which = new URL(req.url).searchParams.get('which')
  const raw = (which === 'moises' ? process.env.WA_BRIDGE_URL_MOISES : process.env.WA_BRIDGE_URL) || ''; const b = raw.endsWith('/') ? raw.slice(0, -1) : raw; if (!b) return NextResponse.json({ ready: false, configured: false }); try { const r = await fetch(b + '/health', { signal: AbortSignal.timeout(8000) }); const j = await r.json(); return NextResponse.json({ ready: !!j.ready, linked_as: j.linked_as || null, configured: true }); } catch { return NextResponse.json({ ready: false, configured: true, error: 'unreachable' }); } }
