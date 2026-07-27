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
 *  GET  /               → status + QR para vincular (HTML)
 *  GET  /health         → JSON { ready }
 *  POST /send           → { phone, text } + header x-bridge-secret
 *  GET  /chats          → chats 1:1 recientes (backfill sync CRM)
 *  GET  /chat-messages  → transcript corto de un chat (clasificación)
 */
const express = require('express')
const QRCode = require('qrcode')
const { Client, LocalAuth } = require('whatsapp-web.js')

const PORT = process.env.PORT || 3009
const SECRET = process.env.BRIDGE_SECRET
if (!SECRET) { console.error('Falta BRIDGE_SECRET'); process.exit(1) }

// URL del webhook del CRM para el sync en vivo (marca leads como contactado).
const CRM_INBOUND_URL = process.env.CRM_INBOUND_URL || 'https://crm-alarcon-production.up.railway.app/api/wa/inbound'

let lastQr = null
let ready = false
let meNumber = null

// Limpiar locks de Chromium huérfanos (quedan en el volumen si el contenedor
// anterior murió — "The profile appears to be in use by another process").
const fs = require('fs')
const path = require('path')
function rmChromiumLocks(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) rmChromiumLocks(p)
      else if (/^Singleton(Lock|Cookie|Socket)$/.test(e.name)) {
        fs.rmSync(p, { force: true })
        console.log('[wa-bridge] lock huérfano eliminado:', p)
      }
    }
  } catch { /* dir aún no existe — primera corrida */ }
}
rmChromiumLocks('./session')

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions', '--disable-software-rasterizer', '--no-first-run',
    ],
  },
})

client.on('qr', qr => { lastQr = qr; ready = false; console.log('[wa-bridge] QR nuevo — escanéalo desde WhatsApp > Dispositivos vinculados') })
client.on('ready', () => {
  ready = true; lastQr = null
  meNumber = client.info?.wid?.user || null
  console.log(`[wa-bridge] ✅ Listo. Vinculado como +${meNumber}`)
})
client.on('disconnected', reason => { ready = false; console.log('[wa-bridge] desconectado:', reason) })

// ── Sync en vivo con el CRM ────────────────────────────────────────────────
// Reporta CADA mensaje del chat 1:1 (entrante y saliente de Fer) al CRM para
// marcar al lead como "contactado" y actualizar su último contacto. Así el
// outbound automático no le vuelve a escribir a alguien que ya está en
// conversación. Solo chats individuales (@c.us): ignora grupos y estados.
// Fire-and-forget: nunca debe romper ni frenar el envío de WhatsApp.
async function reportToCrm(msg) {
  try {
    const chatId = msg.fromMe ? msg.to : msg.from
    if (!chatId || !String(chatId).endsWith('@c.us')) return
    const phone = String(chatId).replace('@c.us', '')
    await fetch(CRM_INBOUND_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-secret': SECRET },
      body: JSON.stringify({ phone, fromMe: !!msg.fromMe, ts: Date.now() }),
    }).catch(() => {})
  } catch { /* nunca romper el bridge por el sync */ }
}
client.on('message_create', reportToCrm)

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

// ── Backfill: lectura de chats (solo lectura, protegido por secret) ─────────
// GET /chats?days=90 → lista de chats individuales con actividad reciente.
app.get('/chats', async (req, res) => {
  if (req.headers['x-bridge-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!ready) return res.status(503).json({ ok: false, error: 'bridge no vinculado' })
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 90))
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400
  try {
    const chats = await client.getChats()
    const out = []
    for (const c of chats) {
      if (c.isGroup) continue
      const id = c.id && c.id._serialized ? c.id._serialized : ''
      if (!id.endsWith('@c.us')) continue
      const ts = c.timestamp || (c.lastMessage && c.lastMessage.timestamp) || 0
      if (ts && ts < cutoff) continue
      out.push({
        phone: id.replace('@c.us', ''),
        name: c.name || null,
        ts: ts || null,
        lastFromMe: !!(c.lastMessage && c.lastMessage.fromMe),
        unread: c.unreadCount || 0,
      })
    }
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0))
    res.json({ ok: true, count: out.length, chats: out })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// GET /chat-messages?phone=52...&limit=25 → transcript corto para clasificar.
app.get('/chat-messages', async (req, res) => {
  if (req.headers['x-bridge-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!ready) return res.status(503).json({ ok: false, error: 'bridge no vinculado' })
  const phone = String(req.query.phone || '').replace(/\D/g, '')
  if (!phone) return res.status(400).json({ ok: false, error: 'phone requerido' })
  const limit = Math.max(1, Math.min(60, parseInt(req.query.limit, 10) || 25))
  try {
    let numberId = null
    for (const c of candidates(phone)) {
      numberId = await client.getNumberId(c)
      if (numberId) break
    }
    if (!numberId) return res.json({ ok: true, phone, messages: [] })
    const chat = await client.getChatById(numberId._serialized)
    const msgs = await chat.fetchMessages({ limit })
    res.json({
      ok: true,
      phone,
      name: chat.name || null,
      messages: msgs.map(m => ({
        fromMe: !!m.fromMe,
        ts: m.timestamp || null,
        type: m.type,
        body: (m.body || '').slice(0, 400),
      })),
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// POST /relink — borra la sesión guardada y reinicia para forzar QR nuevo.
// (destroy() antes del rm evita que el cliente vuelva a re-guardar la sesión.)
app.post('/relink', async (req, res) => {
  if (req.headers['x-bridge-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  res.json({ ok: true, msg: 'relinking — espera ~30s y abre / para escanear el QR' })
  setTimeout(async () => {
    try { await client.destroy() } catch { /* ignore */ }
    try { fs.rmSync('./session', { recursive: true, force: true }) } catch { /* ignore */ }
    process.exit(0) // Railway reinicia el contenedor → arranca sin sesión → QR
  }, 300)
})

app.listen(PORT, () => console.log(`[wa-bridge] escuchando en :${PORT} — abre http://localhost:${PORT} para vincular`))
