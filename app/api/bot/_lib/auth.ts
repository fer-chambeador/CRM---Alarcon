import { NextRequest, NextResponse } from 'next/server'

/**
 * Valida el header x-bot-secret contra la env var BOT_SECRET.
 * Todos los endpoints /api/bot/* deben llamar este helper primero.
 *
 * Uso:
 *   const unauth = requireBotAuth(req)
 *   if (unauth) return unauth
 */
export function requireBotAuth(req: NextRequest): NextResponse | null {
  const expected = process.env.BOT_SECRET
  if (!expected) {
    return NextResponse.json(
      { error: 'BOT_SECRET no configurado en el CRM' },
      { status: 500 },
    )
  }
  const provided = req.headers.get('x-bot-secret')
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return null
}
