/**
 * WA Bridge — vincula el WhatsApp de Fer (personal o Business) como
 * dispositivo (igual que WhatsApp Web) y expone un endpoint /send que el
 * CRM usa para mandar la plantilla outbound desde SU número.
 *
 * ⚠️ IMPORTANTE
 *  - Envíos 1×1, siempre detonados por un humano desde el CRM.
 *  - Cliente no oficial: WhatsApp puede suspender números que detecte
 *    automatizando. Por eso la prueba de estrés se hace primero con el
 *    número personal, con pausas humanas entre mensajes.
 *
 * Uso local (Mac):   cd wa-bridge && npm install && BRIDGE_SECRET=algo npm start
 * Railway:           deploy de esta carpeta, var BRIDGE_SECRET, disco para ./session
 *
 * Endpoints:
 *  GET  /            → status + QR para vincular (HTML)
 *  GET  /health      → JSON { ready }
 *  POST /send        → { phone, text } + header x-bridge-secret
 */
const express = require('express')
const QRCode = require('qrcode')
const { Client, LocalAuth } = require('whatsapp-web.js')

const PORT = process.env.PORT || 3009
const SECRET = process.env.BRIDGE_SECRET
if (!SECRET) { console.error('Falta BRIDGE_SECRET'); process.exit(1) }

let lastQr = null
let ready = false
let meNumber = null

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
})

client.on('qr', qr => { lastQr = qr; ready = false; console.log('[wa-bridge] QR nuevo — escanéalo desde WhatsApp > Dispositivos vinculados') })
client.on('ready', () => {
  ready = true; lastQr = null
  meNumber = client.info?.wid?.user || null
  console.log(`[wa-bridge] ✅ Listo. Vinculado como +${meNumber}`)
})
client.on('disconnected', reason => { ready = false; console.log('[wa-bridge] desconectado:', reason) })
client.initialize()

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true, ready, linked_as: meNumber }))

app.get('/', async (_req, res) => {
  if (ready) {
    return res.send(`<html><body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>✅ WA Bridge listo</h2><p>Vinculado como +${meNumber}</p></div></body></html>`)
  }
  if (!lastQr) return res.send('<html><body style="font-family:sans-serif"><p>Iniciando… recarga en unos segundos.</p></body></html>')
  const dataUrl = await QRCode.toDataURL(lastQr, { width: 320 })
  res.send(`<html><body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>Escanea con WhatsApp</h2><p>WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo</p><img src="${dataUrl}"/><script>setTimeout(()=>location.reload(),8000)</script></div></body></html>`)
})

// Normaliza número MX a formato WhatsApp: 52 + 10 dígitos (y prueba 521 legacy).
function candidates(phone) {
  const d = String(phone).replace(/\D/g, '')
  const last10 = d.slice(-10)
  return [`52${last10}`, `521${last10}`]
}

let lastSendAt = 0
app.post('/send', async (req, res) => {
  if (req.headers['x-bridge-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!ready) return res.status(503).json({ ok: false, error: 'bridge no vinculado — abre / y escanea el QR' })
  const { phone, text } = req.body || {}
  if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone y text requeridos' })

  // Throttle de seguridad: mínimo 5 s entre envíos (esto es 1×1 humano, no blast).
  const wait = 5000 - (Date.now() - lastSendAt)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastSendAt = Date.now()

  try {
    let numberId = null
    for (const c of candidates(phone)) {
      numberId = await client.getNumberId(c)
      if (numberId) break
    }
    if (!numberId) return res.status(404).json({ ok: false, error: `el número ${phone} no tiene WhatsApp` })
    await client.sendMessage(numberId._serialized, text)
    console.log(`[wa-bridge] 📤 enviado a ${numberId._serialized}`)
    res.json({ ok: true, to: numberId._serialized })
  } catch (e) {
    console.error('[wa-bridge] error:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.listen(PORT, () => console.log(`[wa-bridge] escuchando en :${PORT} — abre http://localhost:${PORT} para vincular`))
