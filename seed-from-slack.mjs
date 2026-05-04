/**
 * seed-from-slack.mjs
 *
 * Importa los leads históricos del canal #leads-sales a tu CRM.
 * Usa la API de Slack directamente con el token del bot.
 *
 * Uso:
 *   SLACK_BOT_TOKEN=xoxb-... CRM_URL=https://tu-app.vercel.app node seed-from-slack.mjs
 *
 * O localmente:
 *   SLACK_BOT_TOKEN=xoxb-... CRM_URL=http://localhost:3000 node seed-from-slack.mjs
 */

const CHANNEL_ID = 'C08DP2PPUAJ'  // #leads-sales
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN
const CRM_URL = process.env.CRM_URL || 'http://localhost:3000'

// Fecha de inicio: viernes 1 mayo 2026 (Unix timestamp)
const OLDEST = '1746072000'

async function fetchMessages() {
  const messages = []
  let cursor = undefined

  while (true) {
    const params = new URLSearchParams({
      channel: CHANNEL_ID,
      oldest: OLDEST,
      limit: '200',
    })
    if (cursor) params.set('cursor', cursor)

    const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
    })
    const data = await res.json()

    if (!data.ok) {
      console.error('Error de Slack:', data.error)
      break
    }

    for (const msg of data.messages || []) {
      if (msg.text) messages.push({ text: msg.text, ts: msg.ts })
    }

    if (!data.has_more || !data.response_metadata?.next_cursor) break
    cursor = data.response_metadata.next_cursor
  }

  return messages
}

async function seed() {
  console.log('📥 Obteniendo mensajes de Slack...')
  const messages = await fetchMessages()
  console.log(`📨 ${messages.length} mensajes encontrados`)

  console.log('⬆️  Enviando al CRM...')
  const res = await fetch(`${CRM_URL}/api/leads/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })

  const result = await res.json()
  console.log(`✅ Resultado:`)
  console.log(`   • Insertados: ${result.inserted}`)
  console.log(`   • Actualizados: ${result.updated}`)
  console.log(`   • Ignorados: ${result.skipped}`)
}

seed().catch(console.error)
