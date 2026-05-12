import { TOOLS, callTool } from './tools'

const SERVER_INFO = { name: 'chambas-crm', version: '1.0.0' }
const SUPPORTED_PROTOCOL = '2024-11-05'

type JsonRpcMessage = {
  jsonrpc?: '2.0'
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Single-shot JSON-RPC dispatcher.
 * Returns null for notifications (no response per JSON-RPC spec).
 */
export async function handleMcp(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null
  const isNotification = msg.id === undefined || msg.id === null

  const respond = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } })

  try {
    switch (msg.method) {
      case 'initialize': {
        const result = {
          protocolVersion: SUPPORTED_PROTOCOL,
          serverInfo: SERVER_INFO,
          capabilities: { tools: { listChanged: false } },
        }
        return respond(result)
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
        return null
      case 'tools/list': {
        return respond({ tools: TOOLS })
      }
      case 'tools/call': {
        const params = msg.params || {}
        const name = String(params.name || '')
        const args = (params.arguments as Record<string, unknown>) || {}
        if (!name) return fail(-32602, 'Falta name')
        const result = await callTool(name, args)
        return respond(result)
      }
      case 'resources/list':
      case 'prompts/list':
        return respond({ [msg.method.split('/')[0]]: [] })
      case 'ping':
        return respond({})
      default:
        if (isNotification) return null
        return fail(-32601, `Método no soportado: ${msg.method}`)
    }
  } catch (e) {
    return fail(-32603, e instanceof Error ? e.message : 'Internal error')
  }
}
