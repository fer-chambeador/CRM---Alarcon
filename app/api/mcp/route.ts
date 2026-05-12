import { NextRequest, NextResponse } from 'next/server'
import { handleMcp } from '@/lib/mcp/handler'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function checkAuth(req: NextRequest): boolean {
  const token = process.env.MCP_API_TOKEN
  if (!token) return false  // si no está configurado, todo cerrado
  const header = req.headers.get('authorization') || ''
  const got = header.replace(/^Bearer\s+/i, '').trim()
  return got === token
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  // Healthcheck público (sin auth) si no hay token = no info sensible
  if (!process.env.MCP_API_TOKEN) {
    return NextResponse.json(
      { error: 'MCP no configurado. Falta MCP_API_TOKEN en Railway.' },
      { status: 500, headers: corsHeaders() }
    )
  }
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() })
  }
  return NextResponse.json(
    { server: 'chambas-crm-mcp', version: '1.0.0', transport: 'http', protocol: '2024-11-05' },
    { headers: corsHeaders() }
  )
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400, headers: corsHeaders() }
    )
  }

  // Batch (array) o single message
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map(m => handleMcp(m)))
    const filtered = responses.filter(r => r !== null)
    return NextResponse.json(filtered, { headers: corsHeaders() })
  }

  const response = await handleMcp(body as Parameters<typeof handleMcp>[0])
  if (response === null) {
    return new NextResponse(null, { status: 204, headers: corsHeaders() })
  }
  return NextResponse.json(response, { headers: corsHeaders() })
}
