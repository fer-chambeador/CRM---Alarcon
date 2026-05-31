import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/env-check?secret=<DAPTA_POST_CALL_SECRET>
 *
 * Diagnóstico: devuelve qué env vars empiezan con SLACK_ o VAMBE_ y si están
 * presentes en process.env. NO devuelve el valor (solo si tiene length>0).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const expected = process.env.CRON_SECRET || process.env.DAPTA_POST_CALL_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const allKeys = Object.keys(process.env)
  const slackKeys = allKeys.filter(k => k.startsWith('SLACK_')).map(k => ({
    key: k, length: (process.env[k] || '').length,
  }))
  const vambeKeys = allKeys.filter(k => k.startsWith('VAMBE_')).map(k => ({
    key: k, length: (process.env[k] || '').length,
  }))
  const otherDebug = ['DAPTA_POST_CALL_SECRET', 'CRON_SECRET', 'DEPLOY_TRIGGER'].map(k => ({
    key: k, present: !!process.env[k], length: (process.env[k] || '').length,
  }))

  return NextResponse.json({
    slack_vars: slackKeys,
    vambe_vars: vambeKeys,
    debug_vars: otherDebug,
    total_env_keys: allKeys.length,
    timestamp: new Date().toISOString(),
  })
}
