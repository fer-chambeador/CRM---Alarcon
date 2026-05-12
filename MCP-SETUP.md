# Chambas CRM — MCP Server

Expone el CRM como un MCP server vía HTTP. Cualquier AI assistant compatible
con MCP (Claude Desktop, Cursor, etc.) puede consultar y modificar leads
hablando en lenguaje natural.

## Endpoint

`https://crm-alarcon-production.up.railway.app/api/mcp`

Transporte: HTTP (single endpoint, JSON-RPC 2.0).
Protocol version: `2024-11-05`.

## Setup en Railway

Agregá la variable de entorno:

- `MCP_API_TOKEN` — string secreto largo (generalo con `openssl rand -hex 32`).

Sin esa variable, el endpoint devuelve 500 a todos los requests.

## Auth

Cada request requiere header:

```
Authorization: Bearer <MCP_API_TOKEN>
```

## Tools expuestos

| Tool | Para qué |
|---|---|
| `list_leads` | Filtros: status, canal, estado, score, fechas, vacante. Devuelve summary. |
| `get_lead` | Trae un lead por email o id con actividad reciente y breakdown de score. |
| `update_lead_status` | Cambia el status. Genera entry en activity log. |
| `bump_contact` | Marca un nuevo intento de contacto (resetea timer de 72h hábiles). |
| `update_lead` | Actualiza campos arbitrarios (nombre, monto, presupuesto, llamada_at, etc). |
| `create_lead` | Crea un lead manualmente. |
| `get_analytics` | Pipeline total/cierre/cerrado, breakdowns por canal/estado/vacante/presupuesto en un rango de fechas. |
| `get_pendientes` | Alertas activas agrupadas + próximas llamadas en 7 días. |
| `ask` | Pregunta en lenguaje natural; pasa por el endpoint de AI del CRM. |

## Configurar en Claude Desktop

Claude Desktop hoy soporta MCP servers vía stdio. Para un server remoto HTTP
usamos el bridge oficial `mcp-remote`. Editá tu `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "chambas-crm": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://crm-alarcon-production.up.railway.app/api/mcp",
        "--header",
        "Authorization: Bearer EL_TOKEN_REAL_AQUI"
      ]
    }
  }
}
```

Reiniciá Claude Desktop. Vas a ver "chambas-crm" en el listado de servers
disponibles (icono de tornillito 🔧). De ahí en adelante el AI puede invocar
los tools cuando vos pregunten cosas tipo "qué leads tengo de Recomendación
este mes que no haya contactado todavía".

## Configurar en Cursor

`~/.cursor/mcp.json` (o desde Settings → MCP):

```json
{
  "mcpServers": {
    "chambas-crm": {
      "url": "https://crm-alarcon-production.up.railway.app/api/mcp",
      "headers": {
        "Authorization": "Bearer EL_TOKEN_REAL_AQUI"
      }
    }
  }
}
```

Cursor soporta HTTP MCP nativo, no necesita `mcp-remote`.

## Probar el server con curl

```bash
TOKEN=...

# Initialize
curl -X POST https://crm-alarcon-production.up.railway.app/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# List tools
curl -X POST https://crm-alarcon-production.up.railway.app/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call a tool
curl -X POST https://crm-alarcon-production.up.railway.app/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_leads","arguments":{"status":"contactado","limit":5}}}'
```

## Compartiendo con tu teammate

1. Generá el token: `openssl rand -hex 32`
2. Pegálo como `MCP_API_TOKEN` en Railway → Variables. Railway re-deploya solo.
3. Mandale al teammate el token + el bloque JSON correspondiente (Claude Desktop
   o Cursor) sustituyendo `EL_TOKEN_REAL_AQUI`.
4. Listo. Su AI puede leer y modificar tu CRM con su propia interfaz.

## Rotar / revocar acceso

Cambiá el valor de `MCP_API_TOKEN` en Railway. El token viejo deja de
funcionar inmediatamente.

## Seguridad

- Es un solo token compartido (single-tenant). Suficiente para 1-2 personas
  de confianza.
- Si querés multi-usuario con permisos diferenciados, lo correcto es montar
  Supabase Auth + RLS y emitir JWTs por usuario. Esto sería Phase 18+.
- Los writes (update_lead_status, bump_contact, etc.) generan entries en
  `lead_actividad` con `metadata.source = 'mcp'` para auditoría.
