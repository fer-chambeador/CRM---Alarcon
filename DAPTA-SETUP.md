# Dapta AI — Setup de la integración con el CRM

Esta guía cubre **TODO** lo que necesitás configurar del lado de Dapta para que el feature "Llamadas" funcione end-to-end. El código del CRM ya está listo (página `/llamadas`, endpoints `/api/dapta/*`, schema `llamadas`).

## 0. Lo que ya tenés vs. lo que falta

**Ya está:**
- Agente Voz "Daniela" creado y entrenado con el prompt completo
- Número verificado para outbound

**Falta (esta guía):**
1. **Flow A** — "Trigger Outbound Call" (recibe POST del CRM y dispara la llamada)
2. **Flow B** — "Post-Call Analysis" (recibe el output del agente y lo manda al CRM)
3. Configurar los **11 campos de Post Call Data Retrieval** en el agente
4. Verificar el **firewall/allowlist** para que Dapta pueda llegar al CRM
5. Setear **env vars** en Railway

---

## 1. Flow A — "Trigger Outbound Call"

Este Flow recibe un POST del CRM con los datos del lead y dispara la llamada.

### Crear el flow

1. Dapta → **Flow Studio** → **New Flow** → **New Flow From Scratch**
2. Nombralo: `CRM Trigger Call`

### Configurar el Trigger (Webhook)

1. Click en el nodo **Trigger** (ya viene en cada flow nuevo)
2. **Public Route**: cambiá el método a **POST**
3. **Activá el toggle** del Public Route
4. **Copiá la URL pública** que aparece arriba (la vas a pegar en Railway en el paso 5).
   Tiene esta forma: `https://api.dapta.ai/run/<id>?apiKey=<token>`

### Agregar el nodo "Dapta Phone Call"

1. En el panel derecho, busca **Dapta Phone Call**
2. Arrastralo al canvas, conectalo al Trigger
3. Configurálo:
   - **Voice Agent**: seleccioná a **Daniela**
   - **Phone number to call**: `{{trigger.body.to_number}}`
   - **From phone number**: tu número verificado
   - **Retry logic**: 2 reintentos si no contesta (recomendado)
4. En **Variables del agente**, mapeá los datos que va a usar Daniela en la llamada. Hacé click en "+ Add Variable" y agregá:

| Variable name (en el agente) | Value (desde el webhook) |
|---|---|
| `lead_id` | `{{trigger.body.lead_id}}` |
| `nombre` | `{{trigger.body.nombre}}` |
| `empresa` | `{{trigger.body.empresa}}` |
| `puesto` | `{{trigger.body.puesto}}` |
| `vacante` | `{{trigger.body.vacante}}` |
| `presupuesto` | `{{trigger.body.presupuesto}}` |
| `notas` | `{{trigger.body.notas}}` |

> **Importante**: en el prompt del agente, Daniela ya saluda diciendo "Hola Lic" pero no usa el nombre. Si querés que use el nombre del lead, agregá una línea al prompt: `Cuando tengas la variable {{nombre}} disponible, usala en el saludo en lugar de "Lic".`

### Guardar y testear

1. **Save** el flow
2. **Test**: en otra terminal, hacé un POST de prueba:
   ```bash
   curl -X POST '<URL_PUBLICA_FLOW_A>' \
     -H 'content-type: application/json' \
     -d '{
       "lead_id": "test-uuid",
       "to_number": "+52XXXXXXXXXX",
       "nombre": "Test",
       "empresa": "Test Co",
       "vacante": "meseros"
     }'
   ```
3. Tu teléfono debería sonar en segundos con Daniela del otro lado.

---

## 2. Flow B — "Post-Call Analysis"

Este Flow recibe el análisis al terminar cada llamada y lo manda a nuestro webhook en el CRM.

### Crear el flow

1. Flow Studio → **New Flow** → **New Flow From Scratch**
2. Nombralo: `Post-Call → CRM`

### Configurar el Trigger

1. Click en **Trigger**
2. Método: **POST**
3. Activá el toggle del Public Route (se generará una URL — la usás en el paso 3 abajo, no en el CRM)

### Agregar nodo "HTTP Request" que pega al CRM

1. Buscá **HTTP Request** en el panel derecho
2. Arrastralo, conectalo al Trigger
3. Configurálo:
   - **Method**: POST
   - **URL**: `https://crm-alarcon-production.up.railway.app/api/dapta/post-call?secret=<DAPTA_POST_CALL_SECRET>` (reemplazá `<DAPTA_POST_CALL_SECRET>` por el valor que vas a setear en Railway en el paso 5)
   - **Headers**: `content-type: application/json`
   - **Body** (modo Raw JSON): `{{trigger.body}}`

   Eso reenvía TODO lo que Dapta mandó al Flow B directo a nuestro endpoint.

### Guardar el flow

**Save**. Anotá la URL pública del Flow B — la usás en el paso 3.

---

## 3. Conectar el Flow B al agente Daniela como "Call Analysis Flow"

1. Dapta → **Voice Agents** → Daniela → tab **Call Analysis**
2. **Select Call Analysis Flow** → elegí **Post-Call → CRM**
3. En **Post Call Data Retrieval** → click **+ Add** y agregá uno por uno estos 11 campos. Pegá EXACTAMENTE el prompt y el nombre del campo:

### Los 11 campos a configurar

| Field name | Type | Prompt |
|---|---|---|
| `outcome` | string | `¿Qué pasó al final de la llamada? Devuelve EXACTAMENTE UNA de estas opciones (snake_case, sin texto extra): 'pidio_link_pago' (cliente aceptó comprar y pidió liga de pago o transferencia para una publicación de $1,160), 'pidio_presentacion' (cliente pidió la presentación comercial — porque quiere paquete grande O porque dijo "lo pienso/mándame info"), 'no_interesado' (dijo claramente que no le interesa), 'buzon_voz' (cayó a buzón, no contestó persona), 'numero_equivocado' (era número equivocado o la persona no se registró), 'callback' (pidió que lo llamen más tarde), 'otro' (cualquier otra cosa).` |
| `resumen_detallado` | string | `Resume la llamada en 3-5 frases en español: qué tipo de personal busca, qué zona, qué se le explicó, en qué quedaron al final. Si fue corta o no contestó, dilo brevemente.` |
| `interes_real` | string | `Nivel de interés real del cliente percibido durante la llamada. UNA opción: 'alto' (mostró clara intención de comprar / cerrar pronto), 'medio' (interesado pero dudando, pidió tiempo o presentación), 'bajo' (no se interesó o puso muchas objeciones).` |
| `puesto_buscado` | string | `¿Qué puesto/personal necesita reclutar el cliente? (ej: 'meseros', 'choferes', 'cajeros', 'guardias de seguridad'). Si no lo mencionó, devolver null.` |
| `zona_ubicacion` | string | `¿Qué zona, colonia o ciudad mencionó? (ej: 'Roma Norte CDMX', 'Guadalajara', 'San Pedro Monterrey'). Si no lo mencionó, null.` |
| `presupuesto_paquete` | string | `¿En qué nivel de compra mostró interés? UNA opción: 'una_publicacion' (la primera de $1,160), 'paquete_5' (paquete de 5 publicaciones $5,220), 'paquete_12' ($11,832), 'mas_grande' (mencionó volumen mayor), 'no_definido' (no especificó).` |
| `usa_otra_plataforma` | string | `¿Mencionó que usa alguna otra plataforma de reclutamiento? Si sí, devolver el nombre (ej: 'OCC', 'Indeed', 'Computrabajo', 'agencia'). Si no mencionó, null.` |
| `objeciones` | array of strings | `Lista en un array las objeciones que mencionó el cliente. Opciones comunes: 'caro', 'sin presupuesto', 'ya uso otra plataforma', 'probó antes y no funcionó', 'sin garantía', 'no necesita ahora', 'está ocupado', 'no quiere por WhatsApp'. Array vacío [] si no hubo objeciones.` |
| `proximo_paso` | string | `Próximo paso concreto acordado en frase corta (ej: 'enviar liga de pago por WA', 'enviar presentación comercial', 'Rodrigo le escribe', 'llamar de nuevo el lunes 9am'). Si no quedó un paso claro, null.` |
| `agendar_seguimiento` | string | `Si quedó agendado un callback/seguimiento con fecha y hora específica, devolverlo en formato ISO 8601 (ej: '2026-06-03T15:00:00-06:00' — Mexico timezone). Si no hubo agenda específica, null.` |
| `sentimiento` | string | `Sentimiento general del cliente durante la llamada. UNA opción: 'positivo' (cálido, abierto, interesado), 'neutral' (formal, informativo), 'negativo' (irritado, apurado, cortante).` |

> Daniela ya está entrenada para conseguir todos estos datos — solo tenés que extraer la info al final.

4. **Save** la config del agente.

---

## 4. Firewall — allowlist de IPs de Dapta

Tu CRM corre en Railway, que ya acepta tráfico externo. **Si en algún momento bloqueás por IP**, las IPs de Dapta son:

- `3.135.117.63`
- `3.143.158.83`
- `3.14.139.223`

(Por ahora no hay que hacer nada — Railway no tiene IP allowlist por default.)

---

## 5. Env vars en Railway

Andá a tu proyecto Railway → Variables → agregá:

| Variable | Valor | Descripción |
|---|---|---|
| `DAPTA_TRIGGER_WEBHOOK_URL` | URL pública del **Flow A** | El CRM le pega ahí para disparar llamadas |
| `DAPTA_POST_CALL_SECRET` | Cualquier string aleatorio largo (ej: `dapta_pc_$(openssl rand -hex 32)`) | El secret que va en la query del Flow B → `/api/dapta/post-call` |
| `DAPTA_AGENT_NAME_DEFAULT` | `Daniela` | Solo display |
| `DAPTA_FROM_NUMBER` | Tu número verificado en Dapta (ej: `+525555555555`) | Solo display |

Una vez seteadas, Railway redeploya automático.

---

## 6. Smoke test end-to-end

1. Andá al CRM → `/llamadas`
2. Click **+ Disparar llamada**
3. Buscá un lead con teléfono válido (preferí uno tuyo de prueba para no molestar gente real)
4. Click **📞 Llamar ahora**
5. En segundos, tu teléfono suena con Daniela.
6. Contestá, hablá con ella, terminá la llamada.
7. Esperá 30-60 segundos.
8. Refrescá `/llamadas` — debería aparecer la llamada con status "Completada", outcome detectado, resumen, transcript, accionables.
9. Si pediste liga de pago o presentación, llega un mensaje a Slack en el canal donde tengas `SLACK_ALERT_WEBHOOK_URL`.

---

## 7. Troubleshooting

| Síntoma | Posible causa | Solución |
|---|---|---|
| "Disparar llamada" → error 502 | `DAPTA_TRIGGER_WEBHOOK_URL` mal copiada | Verificá que sea la URL del Public Route del Flow A, con el `?apiKey=...` incluido |
| Llamada se dispara pero nunca aparece resumen en CRM | Flow B no está bien conectado al agente | Voice Agent → Call Analysis tab → confirmá que esté seleccionado el Flow B |
| `/llamadas` muestra "—" en outcome / resumen | Los Post Call Data Retrieval no devuelven nada | Andá al agente → Call Analysis → revisá que los 11 campos estén configurados con sus prompts |
| Slack no recibe alertas | `SLACK_ALERT_WEBHOOK_URL` no seteada en Railway | Setealo |
| Logs `Dapta post-call insert error` | El payload no incluye `data.lead_id` | El Flow B debería forwardear `{{trigger.body}}` completo al CRM, no solo partes |

---

## 8. Schema y endpoints del CRM (referencia)

- **Tabla**: `llamadas` (migración `sql/migrations/2026-05-31-dapta-llamadas.sql`)
- **Endpoints**:
  - `POST /api/dapta/trigger` — disparar (interno del CRM)
  - `POST /api/dapta/post-call?secret=...` — recibe webhook de Dapta
  - `GET /api/llamadas` — lista (con filtros: status, outcome, lead_id)
  - `GET /api/llamadas/[id]` — detalle
  - `GET /api/leads/search?q=...` — picker del modal
- **Páginas**:
  - `/llamadas` — tabla central + modal disparo
  - `/llamadas/[id]` — detalle con transcript, audio, accionables
