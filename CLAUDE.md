# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

CRM custom del equipo de Sales de Chambas. Centraliza leads que llegan por ads de Meta (bot de WhatsApp de Vambe), Slack, Google Calendar y captura manual, y automatiza el funnel de ventas (llamadas, follow-ups, mensajes, eventos a Meta CAPI).

## Tecnologías

- **Next.js 14 (App Router) + React 18 + TypeScript estricto** — UI y API en el mismo proyecto (`app/` con páginas y `app/api/*/route.ts`). CSS plano en `app/globals.css` (sin Tailwind). Libs de UI: `clsx`, `date-fns`, `jspdf`.
- **Supabase (PostgreSQL + Realtime)** vía `@supabase/supabase-js` — sin ORM; queries PostgREST directas. Realtime para la tabla de leads en vivo.
- **Deploy: Railway** (`crm-alarcon-production.up.railway.app`). El `vercel.json` y las menciones a Vercel en `SETUP.md` son legacy — no hay crons de Vercel; los crons son schedulers externos (Railway cron / cron-job.org) que pegan a `app/api/cron/*/route.ts`.
- **`wa-bridge/`** — microservicio aparte (Express + Baileys, Node 20) que vincula el WhatsApp de Fer como dispositivo y expone `/send`; se deploya como servicio separado en Railway con volumen persistente. Ver `wa-bridge/README.md`.
- **Integraciones externas**: Vambe (bot WhatsApp, `lib/vambe.ts`), Google Calendar (OAuth propio + push channels, `lib/googleCalendar.ts`), Dapta (llamadas AI, `lib/dapta.ts`), Slack (webhooks entrantes y alertas salientes), Anthropic API (asistente en `/api/ai`), Meta Conversions API (`lib/metaCapi.ts`), Sentry (por envelope crudo en `lib/errorTracking.ts`, sin SDK).
- **MCP server** en `/api/mcp` (JSON-RPC sobre HTTP, auth `Bearer MCP_API_TOKEN`) — expone tools de leads/analytics a Claude Desktop/Cursor. Ver `MCP-SETUP.md`.

## Comandos

```bash
npm run dev          # dev server local
npx tsc --noEmit     # typecheck (lo que corre el CI)
npm run build        # build (el CI lo corre con placeholders de Supabase, ver .github/workflows/ci.yml)
npm run lint         # next lint
```

No hay tests. El CI (GitHub Actions) es typecheck + build; ambos deben pasar.

No existe `.env.example` ni `.env` local — todas las env vars viven en Railway. Los nombres se descubren buscando `process.env.` en `lib/` y `app/api/`.

## Arquitectura

### Modelo de datos

- **`leads`** es la tabla central. `email` es NOT NULL UNIQUE y es la clave de dedup: los leads sin email real reciben placeholder `{10dígitos}@clientes.chambas.ai` (Vambe) o `{tel}@whatsapp.chambas.ai` (WA bridge) — cualquier lógica que use emails debe excluir esos dominios.
- El tipo canónico es `Lead` en `lib/supabase.ts` (no el SQL). El funnel de `status` (`nuevo → contactado → llamada_agendada → ... → convertido`) está definido ahí y en `lib/status.ts` (labels, orden, colores, alertas por status).
- **`lead_actividad`** es el timeline/audit log: toda mutación relevante de un lead (cambio de status, mensaje, llamada, sync, evento CAPI) inserta una fila con `tipo` propio y `metadata` jsonb. Al agregar efectos nuevos, seguir este patrón.
- **Migraciones**: `sql/migrations/YYYY-MM-DD-nombre.sql`, aplicadas A MANO en el SQL editor de Supabase (no hay tool de migraciones). `sql/schema.sql` es el esquema original y está desactualizado — la verdad está en las migraciones.
- PostgREST capa las respuestas a 1000 filas: para leer tablas completas usar `fetchAllRows()` de `lib/supabase.ts` (ya causó un bug real de leads sin enlazar).

### Flujo de leads (múltiples fuentes → un solo lead)

- **Vambe** (ads Click-to-WhatsApp → bot): webhook en `app/api/vambe/webhook/route.ts`. El formulario llega como mensaje de WhatsApp parseado por `parseFormMessage` (`lib/vambe.ts`); NO crea lead de inmediato — se cachea en `vambe_pending_leads` y se promueve a `leads` cuando el stage de Vambe avanza (`promotePendingLead`). Los stage UUIDs de Vambe mapean a statuses del CRM (`DEFAULT_STAGE_MAP`); los cambios de status por webhook nunca retroceden (`shouldAdvanceStatus`). Todo payload crudo se guarda en `vambe_webhook_log`.
- **Slack** (`#leads-sales`): `app/api/slack/events/route.ts` + `lib/slack-parser.ts` fusionan eventos (usuario nuevo / empresa / suscripción) en un solo lead por email.
- **Google Calendar**: `lib/googleCalendar.ts` importa eventos → matchea leads por email o crea nuevos con status `llamada_agendada`; hay canal de push (webhook `app/api/gcal/webhook`) + reconciliación de cancelados que revierte el status. OAuth con refresh propio, estado en tabla `system_settings`.
- El origen del lead se distingue por `canal_adquisicion` + `tipo_evento` + ids de integración (`vambe_contact_id`, `google_calendar_event_id`, `slack_ts`); helper `isVambeLead()` en `lib/leadVambe.ts`.

### Patrón de integraciones (seguir SIEMPRE)

Un módulo por servicio en `lib/` con su propio wrapper fetch y doc de env vars en el header (ej. `vambeFetch`, `calendarFetch`). Las llamadas salientes son **best-effort**: nunca lanzan hacia el request principal — devuelven `{ok: false, error}` , loggean con prefijo `[modulo]` y reportan con `captureException` de `lib/errorTracking.ts`.

### Crons y auth interna

Endpoints en `app/api/cron/*/route.ts` disparados por scheduler externo cada 10 min. Auth estándar: `?secret=` o header `x-cron-secret` comparado contra `CRON_SECRET || DAPTA_POST_CALL_SECRET`. Si la integración no está configurada devuelven `{ok: true, skipped}` (no error). Los webhooks entrantes usan secrets propios (`VAMBE_WEBHOOK_SECRET`, `GCAL_WEBHOOK_TOKEN`, firma de Slack) y siempre deduplican (retries de proveedores son la norma).

Ejemplo del patrón completo (cron + idempotencia por columna + actividad): `app/api/cron/meta-capi/route.ts`, que manda el evento `Schedule` a Meta CAPI una sola vez por lead agendado (`meta_capi_schedule_sent_at`).

### Convenciones

- Teléfonos: SIEMPRE normalizar con `normalizeMexicanPhone()` (`lib/phoneNormalize.ts`) → formato `+52XXXXXXXXXX`; el matching entre fuentes se hace por los últimos 10 dígitos.
- Comentarios y docs del repo en español; suelen documentar bugs históricos con fecha — respetar ese estilo.
- El frontend (`components/*.tsx`, client components) muta vía `PATCH /api/leads/[id]`, que es el camino canónico: estampa `status_changed_at`, registra actividad y dispara efectos (follow-ups, sync a Calendar). Evitar escrituras de status que salten ese endpoint salvo en integraciones que ya lo hacen (webhook Vambe, gcal import, wa labels).

## Docs adicionales

`SETUP.md` (Slack + bootstrap, parcialmente desactualizado), `DAPTA-SETUP.md`, `MCP-SETUP.md`, `REPORTE-SESION.md` (estado del proyecto y pendientes).
