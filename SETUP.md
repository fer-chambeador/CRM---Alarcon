# 🚀 Chambas CRM — Setup Guide

## Arquitectura

```
#leads-sales (Slack)
      ↓ webhook
Next.js en Vercel  ←→  Supabase (PostgreSQL + Realtime)
      ↓
Dashboard CRM (browser)
```

---

## Paso 1 — Supabase (base de datos)

1. Ve a **https://supabase.com** → New Project
2. Nómbralo `chambas-crm`, elige región más cercana (US East)
3. Una vez creado, ve a **SQL Editor** y pega el contenido de `sql/schema.sql`
4. Ejecuta el script
5. Ve a **Settings → API** y copia:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` ⚠️ nunca expongas esta al browser

---

## Paso 2 — Deploy en Vercel

1. Crea un repo en GitHub y sube este proyecto:
   ```bash
   git init
   git add .
   git commit -m "init chambas crm"
   git remote add origin https://github.com/TU_USER/chambas-crm.git
   git push -u origin main
   ```

2. Ve a **https://vercel.com** → New Project → importa el repo

3. En la pantalla de deploy, agrega estas **Environment Variables**:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   SLACK_SIGNING_SECRET=           ← lo obtendrás en el Paso 3
   ```

4. Deploy → Vercel te dará una URL tipo `https://chambas-crm.vercel.app`

---

## Paso 3 — Slack App (webhook en tiempo real)

1. Ve a **https://api.slack.com/apps** → Create New App → From scratch
   - Nombre: `Chambas CRM Bot`
   - Workspace: el tuyo

2. En **Basic Information** → App Credentials → copia el **Signing Secret**
   → Agrégalo a Vercel como `SLACK_SIGNING_SECRET` y redeploya

3. En **Event Subscriptions**:
   - Enable Events: ON
   - Request URL: `https://chambas-crm.vercel.app/api/slack/events`
   - Slack va a hacer una verificación automática (el endpoint responde al challenge)
   - En **Subscribe to bot events** agrega: `message.channels`

4. En **OAuth & Permissions** → Scopes → Bot Token Scopes:
   - `channels:history`
   - `channels:read`

5. **Install App** al workspace → Autoriza

6. Ve al canal `#leads-sales` en Slack → Invita al bot: `/invite @Chambas CRM Bot`

---

## Paso 4 — Importar leads históricos (del 1 mayo a hoy)

Necesitas el Bot Token (empieza con `xoxb-`):
- Ve a **OAuth & Permissions** → Bot User OAuth Token

Ejecuta desde la carpeta del proyecto:
```bash
SLACK_BOT_TOKEN=xoxb-TU-TOKEN \
CRM_URL=https://chambas-crm.vercel.app \
node seed-from-slack.mjs
```

Verás algo como:
```
📥 Obteniendo mensajes de Slack...
📨 48 mensajes encontrados
⬆️  Enviando al CRM...
✅ Resultado:
   • Insertados: 22
   • Actualizados: 14
   • Ignorados: 12
```

---

## Uso del CRM

- **Ver leads**: La tabla muestra todos los leads en tiempo real
- **Filtrar**: Usa la barra de búsqueda o los filtros de status del sidebar
- **Editar lead**: Click en cualquier fila → modal de edición
- **Registrar contacto**: Botón "📞 Registrar contacto" en el modal (incrementa el contador)
- **Cambiar status**: En el modal, selecciona el status deseado
- **Ver nuevos leads**: Aparece un banner verde cuando llega uno desde Slack en vivo

## Status del funnel

| Status | Significado |
|--------|-------------|
| 🔵 Nuevo | Recién llegó del canal |
| 🟡 Contactado | Ya lo contactaste |
| 🟠 En Negociación | Hay conversación activa |
| 🟢 Convertido | Pagó / firmó (automático si llega suscripción) |
| ⚫ Descartado | No califica |

---

## Flujo automático de eventos Slack

| Evento Slack | Acción en CRM |
|---|---|
| `Usuario nuevo` | Crea lead con email |
| `Compañia creada` | Actualiza/crea con empresa, teléfono, rol, canal |
| `Suscripción nueva` | Actualiza plan → status `convertido` automáticamente |

Los 3 eventos del mismo email se **fusionan en un solo lead** enriqueciendo los datos progresivamente.
