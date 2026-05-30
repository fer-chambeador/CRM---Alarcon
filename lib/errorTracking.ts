/**
 * Error tracking liviano — wrapper sobre console + opcionalmente Sentry.
 *
 * Sentry full SDK pesa mucho y agrega deps. En lugar de eso, usamos el endpoint
 * público de Sentry (envelope) directamente con fetch. Si `SENTRY_DSN` no está
 * configurado, las funciones no-op (solo console.error).
 *
 * Setup:
 *   1. Crear proyecto en sentry.io (free tier hasta 5k errors/mes)
 *   2. Copiar el DSN público (formato: https://KEY@oID.ingest.sentry.io/PID)
 *   3. Setear SENTRY_DSN en Railway
 *
 * Los errores se mandan async, no bloquean el flujo principal.
 */

type SentryEvent = {
  event_id: string
  timestamp: number
  level: 'error' | 'warning' | 'info'
  message?: string
  exception?: {
    values: Array<{ type: string; value: string; stacktrace?: { frames: unknown[] } }>
  }
  tags?: Record<string, string>
  extra?: Record<string, unknown>
  environment?: string
  release?: string
  platform?: 'node'
  server_name?: string
}

function generateEventId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function parseDsn(dsn: string): { url: string; key: string; projectId: string } | null {
  // DSN: https://KEY@host/PROJECT_ID
  try {
    const u = new URL(dsn)
    const key = u.username
    const projectId = u.pathname.replace(/^\//, '')
    if (!key || !projectId) return null
    const url = `${u.protocol}//${u.host}/api/${projectId}/envelope/`
    return { url, key, projectId }
  } catch {
    return null
  }
}

async function sendToSentry(event: SentryEvent): Promise<void> {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  const parsed = parseDsn(dsn)
  if (!parsed) return

  // Sentry envelope format
  const auth = `Sentry sentry_version=7,sentry_key=${parsed.key},sentry_client=chambas-crm/0.1`
  const envelope = [
    JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n')

  try {
    await fetch(parsed.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': auth,
      },
      body: envelope,
    })
  } catch {
    // No re-throw — error tracking nunca debe romper el flujo
  }
}

/**
 * Captura una excepción. Llamala desde catch blocks en endpoints críticos.
 *
 * @example
 *   try { ... } catch (e) { captureException(e, { context: 'vambe webhook' }); throw e; }
 */
export function captureException(err: unknown, extra?: Record<string, unknown>): string {
  const isError = err instanceof Error
  const message = isError ? err.message : String(err)
  const stack = isError && err.stack ? err.stack : undefined

  console.error('[errorTracking]', message, extra || '', stack || '')

  const eventId = generateEventId()
  const event: SentryEvent = {
    event_id: eventId,
    timestamp: Math.floor(Date.now() / 1000),
    level: 'error',
    platform: 'node',
    environment: process.env.NODE_ENV || 'production',
    server_name: process.env.RAILWAY_SERVICE_NAME || 'chambas-crm',
    exception: {
      values: [{
        type: isError ? err.name : 'UnknownError',
        value: message,
        stacktrace: stack ? { frames: parseStackFrames(stack) } : undefined,
      }],
    },
    extra,
  }

  sendToSentry(event)   // fire and forget
  return eventId
}

/**
 * Captura un mensaje (no excepción).
 */
export function captureMessage(message: string, level: 'error' | 'warning' | 'info' = 'info', extra?: Record<string, unknown>): string {
  console[level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'log']('[errorTracking]', message, extra || '')

  const eventId = generateEventId()
  const event: SentryEvent = {
    event_id: eventId,
    timestamp: Math.floor(Date.now() / 1000),
    level,
    platform: 'node',
    environment: process.env.NODE_ENV || 'production',
    message,
    extra,
  }
  sendToSentry(event)
  return eventId
}

/**
 * Helper para envolver un handler de Next.js API route con captura automática.
 *
 * @example
 *   export const POST = withErrorTracking(async (req) => { ... }, 'route_name')
 */
export function withErrorTracking<TReq, TRes>(
  handler: (req: TReq) => Promise<TRes>,
  routeName: string,
): (req: TReq) => Promise<TRes> {
  return async (req: TReq) => {
    try {
      return await handler(req)
    } catch (e) {
      captureException(e, { route: routeName })
      throw e
    }
  }
}

/** Convierte stack string a frames simples para Sentry. */
function parseStackFrames(stack: string): Array<{ filename?: string; function?: string; lineno?: number; in_app: boolean }> {
  const lines = stack.split('\n').slice(1, 11)   // primeras 10 líneas (sin "Error: msg")
  return lines.map(line => {
    const m = line.match(/at\s+(?:(.+?)\s+)?\(?([^()]+):(\d+):(\d+)\)?/)
    if (!m) return { in_app: true }
    return {
      function: m[1] || '<anonymous>',
      filename: m[2],
      lineno: parseInt(m[3], 10),
      in_app: !m[2].includes('node_modules'),
    }
  })
}
