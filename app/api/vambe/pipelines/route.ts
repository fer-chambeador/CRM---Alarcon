import { NextRequest, NextResponse } from 'next/server'
import { listPipelines } from '@/lib/vambe'

export const dynamic = 'force-dynamic'

/**
 * GET /api/vambe/pipelines?secret=...
 *
 * Devuelve todos los pipelines + stages que tenés configurados en Vambe.
 * Sirve para mapear UUID → nombre legible y construir VAMBE_STAGE_MAP.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (!process.env.VAMBE_WEBHOOK_SECRET || secret !== process.env.VAMBE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!process.env.VAMBE_API_KEY) {
    return NextResponse.json({ error: 'VAMBE_API_KEY no configurada' }, { status: 500 })
  }

  try {
    const { pipelines, raw } = await listPipelines()
    // Aplanar a un mapa UUID→nombre para fácil lectura
    const flat: Array<{ pipeline: string; stage_id: string; stage_name: string }> = []
    for (const p of pipelines) {
      const pipelineName = p.name || p.id
      for (const s of p.stages || []) {
        flat.push({
          pipeline: pipelineName,
          stage_id: s.id,
          stage_name: s.name || s.id,
        })
      }
    }
    return NextResponse.json({ pipelines, flat, raw })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
