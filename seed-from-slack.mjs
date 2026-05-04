const CHANNEL_ID = 'C08DP2PPUAJ'
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN
const CRM_URL = process.env.CRM_URL || 'http://localhost:3000'
const OLDEST = '1777615259'

function extractEmail(text) {
  const slackEmail = text.match(/<mailto:([^|>]+)\|[^>]+>/)
  if (slackEmail) return slackEmail[1].toLowerCase().trim()
  const plain = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)
  if (plain) return plain[0].toLowerCase().trim()
  return null
}

function parseMessage(text) {
  if (!text) return null
  const t = text.trim()
  if (!t.toLowerCase().includes('compa') || !t.toLowerCase().includes('creada')) return null

  const email = extractEmail(t)
  const telefono = t.match(/Tel[eé]fono:\s*(.+)/)?.[1]?.trim() || null
  const puesto = t.match(/Rol en la empresa:\s*(.+)/)?.[1]?.trim() || null
  const canal = t.match(/Canal de adquisici[oó]n:\s*(.+)/)?.[1]?.trim() || null
  const empresa = t.match(/Nombre de la empresa:\s*(.+)/)?.[1]?.trim() || null

  // Todos los campos obligatorios
  if (!email || !telefono || !puesto || !canal || !empresa) return null

  // Descartar candidatos
  if (puesto.toLowerCase().includes('soy candidato')) return null

  return { email, telefono, puesto, canal_adquisicion: canal, empresa, tipo_evento: 'empresa_creada' }
}

async function fetchMessages() {
  const messages = []
  let cursor = undefined
  while (true) {
    const params = new URLSearchParams({ channel: CHANNEL_ID, oldest: OLDEST, limit: '200' })
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
    })
    const data = await res.json()
    if (!data.ok) { console.error('Error de Slack:', data.error); break }
    for (const msg of data.messages || []) {
      if (msg.text) messages.push({ text: msg.text, ts: msg.ts })
    }
    if (!data.has_more || !data.response_metadata?.next_cursor) break
    cursor = data.response_metadata.next_cursor
  }
  return messages
}

async function seed() {
  console.log('📥 Obteniendo mensajes desde el 1 mayo 2026...')
  const all = await fetchMessages()
  console.log(`📨 ${all.length} mensajes totales`)
  const leads = all.filter(m => parseMessage(m.text) !== null)
  console.log(`🏢 ${leads.length} leads válidos (con todos los campos)`)
  const res = await fetch(`${CRM_URL}/api/leads/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: leads }),
  })
  const result = await res.json()
  console.log(`✅ Insertados: ${result.inserted} | Actualizados: ${result.updated} | Ignorados: ${result.skipped}`)
}

seed().catch(console.error)
