import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { executeTool, TOOL_DEFINITIONS } from '@/lib/aiTools'

export const dynamic = 'force-dynamic'

/**
 * POST /api/ai/execute-tool
 * Body: { tool: string, input: unknown }
 *
 * Ejecuta una tool del asistente directamente, sin pasar por el modelo.
 * Lo usa el frontend cuando el user clickea "Confirmar" en un modal de
 * acción riesgosa (ej. confirmar bulk_update después de un dry-run).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const tool = body?.tool
  const input = body?.input

  if (!tool || typeof tool !== 'string') {
    return NextResponse.json({ error: 'tool required' }, { status: 400 })
  }
  // Validate the tool exists
  const known = TOOL_DEFINITIONS.find(t => t.name === tool)
  if (!known) {
    return NextResponse.json({ error: `Unknown tool: ${tool}` }, { status: 400 })
  }

  const supabase = createServiceClient()
  const result = await executeTool(tool, input, supabase)
  return NextResponse.json({ tool, input, result })
}
