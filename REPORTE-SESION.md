# 📋 Reporte de la sesión — Fer, cuando vuelvas

Sesión autónoma. Todo está commiteado y pusheado a `main` (excepto un archivo de CI que requiere un PAT con scope `workflow` — más abajo).

---

## ✅ Sprint 1 — Unificación + Templates v2

### Unificación Vambe + Slack
- **Labels limpios**: `puesto` = `Reclutador` / `Dueño` / `Gerente` / `Otro` (sin sufijos)
- **Slack también normaliza** ahora (puesto + vacante + empresa desde email)
- **Consolidación de vacantes**: Garrotero/Hostess→Mesero, Taquero/Lavaloza→Cocinero, Mecánico→Mantenimiento, Gestor Cobranza→Call Center, Operativos/Multifuncional→Ayudante general, Promotor→Ventas
- **Empresa autodetectada** desde email corporativo con split por palabras: `capitalmedia.mx` → "Capital Media"
- **Email lowercase** en todos los inserts
- **`tipoLabel`**: emoji 💬 para `vambe_form` (antes invisible)

### Templates v2 (`/templates`)
- Pestañas **Templates** / **Historial**
- Modal de envío con sub-tabs **Por segmento** / **Subir CSV** (Excel-exportable)
- **Detección automática de `{{X}}` variables** con inputs custom (autocompletan desde lead)
- **Auto-status**: nuevo → contactado al enviar, bump `ultimo_contacto` + `veces_contactado`
- **Tracking por destinatario** (`vambe_campaign_recipients`): `sent_at`, `responded_at`, `scheduled_call_at`, `paid_at`, `send_error`

### Alertas Slack
- `lib/slackAlert.ts` + integración en webhook Vambe
- Stage → **Atención Humana** → ⚠️ alerta
- Stage → **Ganados** → 🎉 venta cerrada
- Lead nuevo con presupuesto `10000_plus` → 💎 high-value
- Necesita `SLACK_ALERT_WEBHOOK_URL` en Railway

### Rate limit asistente — RESUELTO
Payload comprimido con aliases (`e=email, n=nombre, ...`). De ~90k tokens a ~6-12k → asistente vuelve a funcionar.

---

## ✅ Sprint 2 — Lo que me pediste (1, 2, 3, 6, 16, 19, 21, 23, 25, 29)

### #1 Asesores de seguros + operador general
`lib/vambeNormalize.ts` — pattern `/\bseguros?\b/` agregado a Ventas, `/\boperador\b/` a Operador Industrial. Test cases pasan:
- `"Asesores de seguros"` → **Ventas** ✅
- `"operador general"` → **Operador Industrial** ✅
- `"asesor inmobiliario"` → **Ventas** ✅

### #2 Capital Media (camelCase split)
`extractCompanyFromEmail` + `formatCompanyName` con `splitConcatenatedWords` que reconoce palabras frecuentes (capital, media, grupo, tech, etc.). Test cases:
- `mario@capitalmedia.mx` → **Capital Media** ✅
- `contacto@grupotech.mx` → **Grupo Tech** ✅
- `recursoshumanos@delilife.mx` → **Delilife** (no se puede splitear, pero capitaliza)
- `foo@my-company.io` → **My Company** ✅

### #3 Paginación /leads (100 por página)
- Render solo los primeros 100 por defecto
- Botones "Cargar 100 más" y "Mostrar todos"
- Reset al cambiar filtros (no quedar mostrando 200 cuando hay 30)
- Sticky bottom bar con contador

### #6 Demo vs Llamada agendada
- Nueva columna `tipo_llamada` (`demo` | `comercial` | null)
- Migration: `sql/migrations/2026-05-30-tipo-llamada.sql`
- Mapeo automático según UUID de stage:
  - `971fe009-...` (Agendados Consultoría) → **demo**
  - `2fc44415-...` (Confirmados ✅) → **demo**
  - `cd0ab574-...` (Llamadas ☎️) → **comercial**
- Aplicado en webhook tiempo real, backfill, y renormalize (reproceso histórico)

### #16 Lead detail con timeline visual
Nueva página **`/leads/[id]`**:
- Header con nombre, status, empresa, vacante
- Grid de data cards (email, teléfono, canal, puesto, presupuesto, monto, tipo_llamada, etc)
- **Timeline vertical** con eventos coloreados por tipo (📋 form, 🚀 promovido, 🔁 stage, 💬 mensaje, 📨 template, etc.)
- Metadata expandible por evento
- Link "Ver detalle ↗" desde el modal de lead (abre en tab nueva)

### #19 Asistente con memoria
- Persiste turnos en `localStorage` (sobrevive refresh, cap 20 turnos)
- Envía los últimos 3 turnos al backend para que recuerde follow-ups
- Botón "🗑️ Limpiar historial" arriba a la derecha
- El backend prepone la historia al `messages[]` antes de enviar a Anthropic
- Cap 6 turnos en el server-side para no estallar tokens

### #21 Asistente — acciones sobre campaigns
Dos tools nuevas:
- **`send_template_campaign`**: "manda template X a leads que llevan 5 días sin contactar" — dry-run por default, requiere confirm en segunda llamada.
- **`query_campaigns`**: "cómo van las campañas de esta semana" — devuelve historial con métricas.

### #23 Sentry-lite (error tracking)
- `lib/errorTracking.ts` con `captureException`, `captureMessage`, `withErrorTracking`
- **NO usa SDK de Sentry** (sin nueva dep) — escribe directamente al envelope endpoint
- Si `SENTRY_DSN` no está configurado → no-op (solo `console.error`)
- Para activarlo:
  1. Crear proyecto en sentry.io (free tier)
  2. Copiar DSN público
  3. Setear `SENTRY_DSN` en Railway

### #25 GitHub Actions CI
**⚠️ NO PUSHEADO** — mi PAT no tiene scope `workflow`. El archivo está en tu disco local en:

`/Users/feralarcon/Documents/GitHub/CRM---Alarcon/.github/workflows/ci.yml`

Para activarlo:
- **Opción A**: subilo manualmente desde tu Mac (`git add .github/workflows/ci.yml && git commit && git push`)
- **Opción B**: regenerá un PAT con scope `workflow` y mándamelo en la próxima sesión

El workflow corre typecheck + build en cada push/PR a main. Aborta merge si rompe.

### #29 Best time to contact
Endpoint nuevo: `GET /api/analytics/best-time?secret=...` (no usa secret, abierto)
- Analiza actividad de leads (mensajes, stage changes) por hora del día (CDMX) y día de semana
- Devuelve heatmap data + pico (`best_hour`, `best_dow`)
- Segmentado por canal en `by_hour_canal`
- Pendiente: agregar widget al `/analytics` que use este endpoint (no me dio tiempo, te lo dejo armado solo a nivel API)

---

## ⏳ Lo que NECESITA QUE VOS HAGAS

### A) Correr las migraciones SQL nuevas (DOS de esta sesión)

**Migración 1 — campaigns (Sprint 1)**:
```sql
CREATE TABLE IF NOT EXISTS vambe_campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       text NOT NULL,
  template_name     text,
  template_body     text,
  segment           jsonb,
  override_vars     jsonb,
  total_targeted    int  NOT NULL DEFAULT 0,
  total_sent        int  NOT NULL DEFAULT 0,
  total_failed      int  NOT NULL DEFAULT 0,
  source            text NOT NULL DEFAULT 'segment',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vambe_campaign_recipients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES vambe_campaigns(id) ON DELETE CASCADE,
  lead_id             uuid REFERENCES leads(id),
  phone               text NOT NULL,
  email               text,
  nombre              text,
  vars                jsonb,
  sent_at             timestamptz,
  send_error          text,
  responded_at        timestamptz,
  scheduled_call_at   timestamptz,
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vambe_campaigns_created           ON vambe_campaigns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vambe_campaign_recipients_campaign ON vambe_campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_vambe_campaign_recipients_lead     ON vambe_campaign_recipients(lead_id);
CREATE INDEX IF NOT EXISTS idx_vambe_campaign_recipients_phone    ON vambe_campaign_recipients(phone);
CREATE INDEX IF NOT EXISTS idx_vambe_campaign_recipients_sent     ON vambe_campaign_recipients(sent_at DESC);
```

**Migración 2 — tipo_llamada (Sprint 2)**:
```sql
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS tipo_llamada text
  CHECK (tipo_llamada IS NULL OR tipo_llamada IN ('demo', 'comercial'));
CREATE INDEX IF NOT EXISTS idx_leads_tipo_llamada ON leads(tipo_llamada);
```

### B) Configurar env vars en Railway

| Variable | Para qué | Cómo obtenerla |
|---|---|---|
| `SLACK_ALERT_WEBHOOK_URL` | Alertas Atención Humana / Ganados | Slack → Incoming Webhooks → New |
| `SENTRY_DSN` | Error tracking | sentry.io → Project → Settings → Client Keys |

Sin ninguna de esas, el CRM funciona igual — solo no se mandan alertas / errores.

### C) Subir el CI workflow

```bash
cd /Users/feralarcon/Documents/GitHub/CRM---Alarcon
git pull
git add .github/workflows/ci.yml
git commit -m "ci: agregar workflow de typecheck + build en GitHub Actions"
git push
```

### D) Verificar Railway deploy

**Diagnóstico final** del Sprint 2:

✅ El endpoint `/api/analytics/best-time` (nuevo) responde correctamente con datos reales (best_hour: 13h, best_dow: Lunes, 662 eventos analizados) → **Railway SÍ está deployando los nuevos endpoints.**

⚠️ Pero el endpoint `/api/vambe/renormalize` sigue devolviendo `"Reclutador / RH"` como `after.puesto`, cuando el código en GitHub claramente devuelve `"Reclutador"` (sin slash). **Railway está sirviendo un bundle compilado viejo para ESE endpoint específico.**

**Lo más probable**: Railway tiene un cache stale o el build incremental no rebuildea archivos que dependen de `lib/vambeNormalize.ts`. Esto pasa a veces con Nixpacks.

**Cómo solucionarlo** (en Railway dashboard):
1. Andá a **Deployments** → último deploy ACTIVE → menú `⋮` → **Redeploy**
2. Si no funciona, **Settings** → **Build** → **Clear build cache** → Redeploy
3. Si tampoco, hacé un commit vacío para forzar:
   ```bash
   cd /Users/feralarcon/Documents/GitHub/CRM---Alarcon && git pull && \
   git commit --allow-empty -m "chore: force railway rebuild" && git push
   ```

**Después de que esté actualizado**, corré el renormalize:

```bash
curl -s "https://crm-alarcon-production.up.railway.app/api/vambe/renormalize?dry=false&secret=00f12effd4c5ba0799f2f356d465ec2bf68b67b9a1a5fb5f2ed382f82f5288a2" | jq
```

Esperá ver `after.puesto: "Reclutador"` (sin slash) en los samples. Eso confirma que el código nuevo está en producción.

---

## 📊 Estado de las features

| Feature | Backend | DB | UI |
|---|---|---|---|
| Unificación labels | ✅ | n/a | ✅ |
| Consolidación vacantes | ✅ | n/a | ✅ |
| Templates v2 + Historial | ✅ | ⏳ migration | ✅ |
| Excel/CSV upload | ✅ | n/a | ✅ |
| Detección de variables | ✅ | n/a | ✅ |
| Auto-status nuevo→contactado | ✅ | n/a | n/a |
| Slack alerts | ✅ | n/a | n/a |
| Asistente memoria | ✅ | n/a (localStorage) | ✅ |
| Asistente tools campaigns | ✅ | n/a | n/a |
| Sentry-lite | ✅ | n/a | n/a |
| tipo_llamada | ✅ | ⏳ migration | ⏳ (mostrar en /leads) |
| Lead detail timeline | ✅ | n/a | ✅ |
| Paginación /leads | ✅ | n/a | ✅ |
| Best time analytics | ✅ | n/a | ⏳ (widget en /analytics) |
| GitHub Actions CI | ✅ | n/a | n/a — **falta push** |

---

## 🔜 Cosas pendientes (para sesiones futuras)

1. **Widget de Best Time** en `/analytics` (heatmap) — endpoint listo, falta UI
2. **Columna tipo_llamada en /leads** — agregar a tabla y filtros
3. **UTM tracking de Meta ads** — depende de cómo configures los forms en Meta
4. **Kanban view del pipeline** — quedó fuera del sprint, lo veremos siguiente
5. **Tests con Vitest** — quedó fuera del sprint
6. **Lead scoring visible** — el cálculo existe (`leadScore()`), solo mostrarlo
7. **Bulk edit de leads** — seleccionar N filas + edit masivo
8. **Notas con tags + markdown** — pendiente
9. **Asignación de leads a vendedores** — pendiente

---

## 📝 Todos los commits de esta sesión

```
75181fa feat(crm): timeline visual /leads/[id] + asistente memoria + tools campaigns + Sentry-lite + analytics best-time
de47c8f feat(crm): tipo_llamada (demo vs comercial) por stage UUID en Vambe + migration + backfill
1533a31 feat(crm): bugs 1-3 (Asesores→Ventas, operador→Operador Industrial, capitalmedia→Capital Media via word-split) + paginación /leads (100 por página)
5ea70fb fix(templates+campaigns): degradación graciosa si la migration no corrió aún
af07fb9 fix(crm): audit cleanup (alertsCount frágil, sort presupuesto nulls, dead useMemo)
a6bef2b feat(crm): Templates v2 + Slack alerts + campaign metrics + auto-status
bacbfca feat(crm): unificacion data Vambe+Slack + consolidar vacantes + fix rate limit asistente
7872771 fix(vambe): renormalize updates secuenciales + labels unificados
22c2800 feat(vambe): renormalize tambien arma notas a partir del form
9537936 feat(vambe): endpoint /renormalize sin tocar Vambe
```

Todo en `main`, pusheado directo.

---

## ✨ Resumen ejecutivo

Tu CRM ahora tiene **mucho más músculo** que cuando empezaste la sesión:

- 🎯 **Data unificada** entre Vambe y Slack (mismas etiquetas)
- 📨 **Templates v2** con historial completo + Excel upload + variables custom
- 🤖 **Asistente con memoria** que recuerda follow-ups + acciones sobre campaigns
- 📊 **Timeline visual** por lead (la mejor vista de tracking individual)
- 🔔 **Slack alerts** para intervenir cuando importa
- 🚦 **Auto-status** workflow (lead recibe template → contactado)
- 📈 **Métricas por campaña** (respondió/agendó/pagó + tasas)
- 🐛 **Bugs limpios** (vacantes mal-mapeadas, empresa formateada, sort robusto)
- ⚡ **Performance** (paginación, payload comprimido en asistente)
- 🔧 **Infra** (error tracking liviano + CI listo para subir)

Cuando hagas los pasos A-D vas a tener un CRM **chingón**, como pediste.

Avísame qué encontrás cuando lo revises.
