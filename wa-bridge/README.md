# WA Bridge — mensajes desde el WhatsApp de Fer

Microservicio que vincula el WhatsApp de Fer como **dispositivo** (igual que
WhatsApp Web) y expone `/send` para que el CRM mande la plantilla outbound
desde su número, 1×1, cuando Fer da clic en **Mensaje → WhatsApp**.

## Prueba de estrés (número personal primero)

```bash
cd wa-bridge
npm install
BRIDGE_SECRET=un-secreto npm start
# abre http://localhost:3009 y escanea el QR con el WhatsApp PERSONAL (5517282187)
# en otra terminal:
BRIDGE_SECRET=un-secreto TARGET=5215517282187 N=10 npm run stress
```

⚠️ whatsapp-web.js es cliente NO oficial — WhatsApp puede suspender números
que detecte automatizando. Por eso: primero número personal, envíos 1×1 con
throttle de 5 s y pausas humanas en el stress test.

## Producción (Railway)

1. Nuevo servicio desde este repo, root dir `wa-bridge/`.
2. Variables: `BRIDGE_SECRET` (inventa uno largo).
3. Volumen persistente montado en `/app/session` (para no re-escanear QR).
4. En el servicio del CRM agrega: `WA_BRIDGE_URL=https://<url-del-bridge>` y
   `WA_BRIDGE_SECRET=<el mismo secreto>`.
5. Abre la URL del bridge y escanea el QR con el WhatsApp Business.
