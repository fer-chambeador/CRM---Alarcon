/**
 * WA Bridge (Baileys) — vincula el WhatsApp de Fer por el protocolo multi-device
 * (WebSocket, SIN navegador). Reemplaza whatsapp-web.js, cuyo Store se rompía
 * con la versión actual de WhatsApp Web (error "r"). Baileys es inmune a eso.
 *
 * Misma API HTTP que antes (para no tocar el CRM):
 *  GET  /               → status + QR para vincular (HTML)
 *  GET  /health         → { ok, ready, linked_as }
 *  POST /send           → { phone, text } + header x-bridge-secret
 *  GET  /chats          → chats 1:1 recientes (backfill)
 *  GET  /chat-messages  → transcript corto de un chat
 *  POST /relink         → borra la sesión y reinicia para QR nuevo
 *
 * Sync en vivo: cada mensaje 1:1 (entrante y saliente) se reporta al CRM.
 */
const express = require('express')
const QRCode = require('qrcode')
const fs = require('fs')
const path = require('path')
const P = require('pino')({ level: 'silent' })
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')

const PORT = process.env.PORT || 3009
const SECRET = process.env.BRIDGE_SECRET
if (!SECRET) { console.error('Falta BRIDGE_SECRET'); process.exit(1) }
const CRM_INBOUND_URL = process.env.CRM_INBOUND_URL || 'https://crm-alarcon-production.up.railway.app/api/wa/inbound'
const CRM_LABELS_URL = process.env.CRM_LABELS_URL || 'https://crm-alarcon-production.up.railway.app/api/wa/labels'
const AUTH_DIR = './session/auth'

let sock = null
let lastQr = null
let ready = false
let meNumber = null

// Store mínimo en memoria para el backfill (Baileys no trae getChats).
const chatStore = new Map()   // jid -> { name, ts, lastFromMe }
const msgStore = new Map()    // jid -> [{ fromMe, ts, type, body }]  (máx 50)
const labelDefs = new Map()   // labelId -> name  (etiquetas de WhatsApp Business)
const chatLabels = new Map()  // jid -> Set(labelId)

function only1to1(jid) { return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net') }
function phoneOf(jid) { return String(jid || '').split('@')[0].split(':')[0] }

function extractText(m) {
  const msg = m && m.message ? m.message : {}
  return (
    msg.conversation ||
    (msg.extendedTextMessage && msg.extendedTextMessage.text) ||
    (msg.imageMessage && msg.imageMessage.caption) ||
    (msg.videoMessage && msg.videoMessage.caption) ||
    (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedButtonId) ||
    (msg.listResponseMessage && msg.listResponseMessage.title) ||
    ''
  )
}
function typeOf(m) {
  const msg = m && m.message ? m.message : {}
  const k = Object.keys(msg)[0] || 'chat'
  if (/image/i.test(k)) return 'image'
  if (/video/i.test(k)) return 'video'
  if (/document/i.test(k)) return 'document'
  if (/audio|ptt/i.test(k)) return 'audio'
  return 'chat'
}

function recordMessage(m) {
  try {
    const jid = m.key && m.key.remoteJid
    if (!only1to1(jid)) return
    const fromMe = !!(m.key && m.key.fromMe)
    const ts = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000)
    const body = String(extractText(m) || '')
    const type = typeOf(m)
    // chat index
    const prev = chatStore.get(jid) || {}
    if (!prev.ts || ts >= prev.ts) chatStore.set(jid, { name: prev.name || null, ts, lastFromMe: fromMe })
    else chatStore.set(jid, { ...prev, name: prev.name || null })
    // messages (cap 50, orden cronológico aprox)
    const arr = msgStore.get(jid) || []
    arr.push({ fromMe, ts, type, body })
    arr.sort((a, b) => (a.ts || 0) - (b.ts || 0))
    if (arr.length > 50) arr.splice(0, arr.length - 50)
    msgStore.set(jid, arr)
  } catch { /* no romper por el store */ }
}

async function reportToCrm(phone, fromMe) {
  try {
    await fetch(CRM_INBOUND_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-secret': SECRET },
      body: JSON.stringify({ phone, fromMe: !!fromMe, ts: Date.now() }),
    }).catch(() => {})
  } catch { /* fire and forget */ }
}

// Reporta al CRM las etiquetas de WhatsApp Business de un chat 1:1.
async function reportLabelsToCrm(jid) {
  try {
    if (!only1to1(jid)) return
    const set = chatLabels.get(jid)
    const labels = set ? [...set].map(id => labelDefs.get(id)).filter(Boolean) : []
    await fetch(CRM_LABELS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-secret': SECRET },
      body: JSON.stringify({ phone: phoneOf(jid), labels }),
    }).catch(() => {})
  } catch { /* fire and forget */ }
}

// Sync periódico de TODAS las etiquetas actuales (backfill inicial + cambios).
// El CRM deduplica: si la etiqueta no cambió, no hace nada.
setInterval(() => { for (const jid of chatLabels.keys()) reportLabelsToCrm(jid) }, 5 * 60 * 1000)

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  // Negociar la versión ACTUAL de WhatsApp (sin esto, WhatsApp rechaza con 428).
  // Con timeout para no colgar el arranque si la red no responde.
  let version
  try {
    const r = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ])
    version = r && r.version
    console.log('[wa-bridge] WA version negociada:', JSON.stringify(version))
  } catch (e) {
    console.log('[wa-bridge] fetchLatestBaileysVersion falló:', e && e.message)
  }
  console.log('[wa-bridge] creando socket Baileys...')
  sock = makeWASocket({
    version,
    auth: state,
    logger: P,
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    syncFullHistory: true,
    markOnlineOnConnect: false,
  })
  console.log('[wa-bridge] socket creado, esperando QR / conexión...')

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) { lastQr = qr; ready = false; console.log('[wa-bridge] 📲 QR generado') }
    if (connection === 'open') {
      ready = true; lastQr = null
      meNumber = phoneOf(sock.user && sock.user.id)
      console.log('[wa-bridge] ✅ Vinculado como', meNumber)
      setTimeout(() => {
        try { sock.resyncAppState(['critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false).catch(() => {}) } catch { /* ignore */ }
      }, 4000)
    }
    if (connection === 'close') {
      ready = false
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : null
      console.log('[wa-bridge] conexión cerrada, code=', code)
      if (code === DisconnectReason.loggedOut) {
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
        setTimeout(() => startSock().catch(e => console.error('restart err', e && e.message)), 1500)
      } else {
        setTimeout(() => startSock().catch(e => console.error('reconnect err', e && e.message)), 60000)
      }
    }
  })

  sock.ev.on('messaging-history.set', (h) => {
    try {
      const chats = h.chats || []
      for (const c of chats) {
        if (!only1to1(c.id)) continue
        const ts = Number(c.conversationTimestamp) || null
        const prev = chatStore.get(c.id) || {}
        chatStore.set(c.id, { name: c.name || c.notify || prev.name || null, ts: ts || prev.ts || null, lastFromMe: prev.lastFromMe || false })
      }
      const msgs = h.messages || []
      for (const m of msgs) recordMessage(m)
    } catch { /* ignore */ }
  })

  sock.ev.on('messages.upsert', (up) => {
    try {
      const messages = up.messages || []
      for (const m of messages) {
        const jid = m.key && m.key.remoteJid
        if (!only1to1(jid)) continue
        recordMessage(m)
        reportToCrm(phoneOf(jid), !!(m.key && m.key.fromMe))
      }
    } catch { /* ignore */ }
  })

  sock.ev.on('labels.edit', (label) => {
    try {
      if (!label || label.id == null) return
      const id = String(label.id)
      if (label.deleted) labelDefs.delete(id)
      else labelDefs.set(id, label.name || id)
    } catch { /* ignore */ }
  })
  sock.ev.on('labels.association', (ev) => {
    try {
      const a = (ev && ev.association) || {}
      const jid = a.chatId
      if (!jid || !only1to1(jid) || a.labelId == null) return
      const lid = String(a.labelId)
      let set = chatLabels.get(jid)
      if (!set) { set = new Set(); chatLabels.set(jid, set) }
      if (ev.type === 'remove') set.delete(lid)
      else set.add(lid)
      reportLabelsToCrm(jid)  // push en vivo al CRM
    } catch { /* ignore */ }
  })

  sock.ev.on('contacts.upsert', (cs) => {
    try {
      for (const c of cs || []) {
        if (!only1to1(c.id)) continue
        const prev = chatStore.get(c.id) || {}
        chatStore.set(c.id, { ...prev, name: c.name || c.notify || prev.name || null })
      }
    } catch { /* ignore */ }
  })
}

startSock().catch(e => console.error('[wa-bridge] startSock error:', e && e.message))

const CRM_BACKFILL_URL = process.env.CRM_BACKFILL_URL || 'https://crm-alarcon-production.up.railway.app/api/wa/backfill'
let lastCronKey = ''
setInterval(async () => {
  try {
    if (!ready) return
    const now = new Date()
    const hCdmx = (now.getUTCHours() - 6 + 24) % 24
    const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${hCdmx}`
    if ((hCdmx === 9 || hCdmx === 20) && key !== lastCronKey) {
      lastCronKey = key
      console.log('[wa-bridge] ⏰ cross-check programado', hCdmx + 'h CDMX')
      const r = await fetch(CRM_BACKFILL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-secret': SECRET },
        body: JSON.stringify({ days: 120, applyExisting: true, createUnknown: false, unknownLimit: 0 }),
      })
      console.log('[wa-bridge] cross-check resultado:', (await r.text()).slice(0, 150))
    }
  } catch (e) { console.log('[wa-bridge] cross-check error:', e && e.message) }
}, 60 * 1000)

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true, ready, linked_as: meNumber }))

app.get('/', async (_req, res) => {
  if (ready) {
    return res.send(`<html><body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>✅ WA Bridge listo</h2><p>Vinculado como +${meNumber}</p></div></body></html>`)
  }
  if (!lastQr) return res.send('<html><body style="font-family:sans-serif"><p>Iniciando… recarga en unos segundos.</p><script>setTimeout(()=>location.reload(),4000)</script></body></html>')
  const dataUrl = await QRCode.toDataURL(lastQr, { width: 320 })
  res.send(`<html><body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>Escanea con WhatsApp</h2><p>WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo</p><img src="${dataUrl}"/><script>setTimeout(()=>location.reload(),8000)</script></div></body></html>`)
})

function toMxNumber(phone) {
  const d = String(phone).replace(/\D/g, '')
  return '52' + d.slice(-10)
}

let lastSendAt = 0
app.post('/send', async (req, res) => {
  if (req.headers['x-bridge-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!ready || !sock) return res.status(503).json({ ok: false, error: 'bridge no vinculado — abre / y escanea el QR' })
  const { phone, text } = req.body || {}
  if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone y text requeridos' })

  const wait = 5000 - (Date.now() - lastSendAt)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastSendAt = Date.now()

  try {
    const num = toMxNumber(phone)
    const [info] = await sock.onWhatsApp(num)
    if (!info || !info.exists) return res.status(404).json({ ok: false, error: `el número ${phone} no tiene WhatsApp` })
    await sock.sendMessage(info.jid, { text: String(text) })
    console.log('[wa-bridge] 📤 enviado a', info.jid)
    res.json({ ok: true, to: info.jid })
  } catch (e) {
    console.error('[wa-bridge] error /send:', e && e.message)
    res.status(500).json({ ok: false, error: e && e.message })
  }
})

app.get('/chats', (req, res) => {
  if (req.headers['x-bridge-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!ready) return res.status(503).json({ ok: false, error: 'bridge no vinculado' })
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 90))
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400
  const out = []
  for (const [jid, v] of chatStore.entries()) {
    if (!only1to1(jid)) continue
    if (v.ts && v.ts < cutoff) continue
    const lids = chatLabels.get(jid)
    const labels = lids ? [...lids].map(id => labelDefs.get(id)).filter(Boolean) : []
    out.push({ phone: phoneOf(jid), name: v.name || null, ts: v.ts || null, lastFromMe: !!v.lastFromMe, labels })
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  res.json({ ok: true, count: out.length, chats: out })
})

app.get('/labels', (req, res) => {
  if (req.headers['x-bridge-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const counts = {}
  for (const set of chatLabels.values()) for (const lid of set) counts[lid] = (counts[lid] || 0) + 1
  const labels = [...labelDefs.entries()].map(([id, name]) => ({ id, name, chats: counts[id] || 0 }))
  res.json({ ok: true, ready, labels, taggedChats: chatLabels.size })
})

app.get('/chat-messages', (req, res) => {
  if (req.headers['x-bridge-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  if (!ready) return res.status(503).json({ ok: false, error: 'bridge no vinculado' })
  const phone = String(req.query.phone || '').replace(/\D/g, '')
  if (!phone) return res.status(400).json({ ok: false, error: 'phone requerido' })
  const last10 = phone.slice(-10)
  let found = null
  for (const jid of msgStore.keys()) { if (phoneOf(jid).slice(-10) === last10) { found = jid; break } }
  const limit = Math.max(1, Math.min(60, parseInt(req.query.limit, 10) || 25))
  const msgs = (found ? msgStore.get(found) : []).slice(-limit).map(m => ({ fromMe: m.fromMe, ts: m.ts, type: m.type, body: (m.body || '').slice(0, 400) }))
  res.json({ ok: true, phone, name: (found && chatStore.get(found) && chatStore.get(found).name) || null, messages: msgs })
})

app.post('/relink', async (req, res) => {
  if (req.headers['x-bridge-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
  res.json({ ok: true, msg: 'relinking — espera ~20s y abre / para escanear el QR' })
  setTimeout(async () => {
    try { if (sock) await Promise.race([sock.logout().catch(() => {}), new Promise(r => setTimeout(r, 3000))]) } catch { /* ignore */ }
    try { for (const e of fs.readdirSync('./session')) fs.rmSync(path.join('./session', e), { recursive: true, force: true }) } catch { /* ignore */ }
    process.exit(0)
  }, 300)
})

app.listen(PORT, () => console.log(`[wa-bridge] (baileys) escuchando en :${PORT}`))
