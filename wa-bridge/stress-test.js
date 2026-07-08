/**
 * Prueba de estrés del WA Bridge — manda N mensajes de prueba al número
 * TARGET con pausas aleatorias "humanas" (8-20 s) para validar estabilidad
 * del vínculo antes de usarlo con leads reales.
 *
 * Uso: BRIDGE_SECRET=algo TARGET=5215517282187 N=10 node stress-test.js
 */
const SECRET = process.env.BRIDGE_SECRET
const TARGET = process.env.TARGET
const N = parseInt(process.env.N || '10', 10)
const URL = process.env.BRIDGE_URL || 'http://localhost:3009'
if (!SECRET || !TARGET) { console.error('Faltan BRIDGE_SECRET / TARGET'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  let ok = 0, fail = 0
  for (let i = 1; i <= N; i++) {
    const text = `🧪 Prueba de estrés WA Bridge ${i}/${N} — ${new Date().toLocaleTimeString('es-MX')}`
    try {
      const res = await fetch(`${URL}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-secret': SECRET },
        body: JSON.stringify({ phone: TARGET, text }),
      })
      const data = await res.json()
      if (data.ok) { ok++; console.log(`✅ ${i}/${N} enviado`) }
      else { fail++; console.log(`❌ ${i}/${N} error: ${data.error}`) }
    } catch (e) { fail++; console.log(`❌ ${i}/${N} excepción: ${e.message}`) }
    if (i < N) await sleep(8000 + Math.random() * 12000)
  }
  console.log(`\nResultado: ${ok} ok, ${fail} fallidos de ${N}`)
})()
