import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { phoneToState } from '@/lib/lada'

export const dynamic = 'force-dynamic'

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'  // fast + cheap; switch to claude-sonnet-4-6 for harder queries

const SYSTEM = `Eres un analista de datos del CRM de Chambas. El usuario es Fer, dueño del producto.

Te paso TODOS los leads como JSON al inicio. Cada lead tiene:
- email, nombre, empresa, telefono
- puesto (decision maker — rol del contacto en su empresa: Reclutador, Dueño, etc.)
- vacante (puesto que el cliente está buscando reclutar — Cocinero, Seguridad, Chofer, etc.)
- canal_adquisicion (Instagram, TikTok, Facebook, Inbound, Google, Recomendación, etc.)
- estado (estado mexicano derivado del LADA del teléfono)
- status: nuevo | contactado | llamada_agendada | no_show_llamada | presentacion_enviada | espera_aprobacion | convertido | cliente_recurrente | descartado
- monto (MXN, default 1160; el "pipeline" de ese lead)
- presupuesto (tier de inversión declarado en onboarding):
    none = "No invierte"
    100_to_1000 = "$100 a $1,000"
    2000_to_5000 = "$2,000 a $5,000"
    10000_plus = "+$10,000"
    null = "No registrado" (leads previos a la captura del campo)
- created_at, status_changed_at (ISO)
- veces_contactado (0..4)

DIFERENCIA CLAVE: "puesto" = el rol del contacto en SU empresa (decision maker).
                  "vacante" = el rol que ESE cliente quiere reclutar para su empresa.
Cuando el usuario pregunte "qué tipo de vacantes" / "qué roles buscan reclutar"
/ "qué puestos cierran mejor", referite al campo vacante, no a puesto.

REGLAS:
- Pipeline cerrado = SUM(monto) de leads con status convertido o cliente_recurrente.
- Pipeline en cierre = SUM(monto) de leads con status presentacion_enviada o espera_aprobacion.
- Convertidos = count de leads con status convertido o cliente_recurrente.
- "Decision maker" se refiere al campo puesto.
- Cuando el usuario diga "este mes" / "esta semana" usa created_at del lead. Hoy es ${new Date().toISOString().slice(0, 10)}.
- Da números concretos (counts, montos en MXN con $ y comas, %).
- Sé conciso. Markdown ok pero sin headers grandes; usa listas o tablas markdown si ayuda.
- Si la pregunta es ambigua, da la mejor respuesta y al final aclara qué supusiste.
- Si la respuesta involucra >5 leads, agrúpalos en vez de listarlos uno por uno.
- Idioma: español de México.`

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({
      error: 'Falta ANTHROPIC_API_KEY en las variables de entorno de Railway. Andá a Railway → Variables y agregá la key.',
    }, { status: 500 })
  }

  const body = await req.json().catch(() => null)
  const question: string = (body?.question || '').toString().trim()
  if (!question) return NextResponse.json({ error: 'Pregunta vacía' }, { status: 400 })

  const supabase = createServiceClient()
  const { data: leads, error } = await supabase
    .from('leads')
    .select('email,nombre,empresa,telefono,puesto,vacante,canal_adquisicion,status,monto,veces_contactado,created_at,status_changed_at,estado,presupuesto')
    .order('created_at', { ascending: false })
    .limit(2000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Annotate each lead with the resolved state (manual override wins,
  // otherwise derive from the LADA of the phone).
  const enriched = (leads || []).map(l => ({
    ...l,
    estado: l.estado || phoneToState(l.telefono),
  }))

  const userMsg = `Aquí están los ${enriched.length} leads como JSON:\n\n\`\`\`json\n${JSON.stringify(enriched)}\n\`\`\`\n\nPregunta:\n${question}`

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    return NextResponse.json({ error: `API Anthropic ${res.status}: ${text.slice(0, 300)}` }, { status: 502 })
  }
  const data = await res.json()
  const answer = data?.content?.[0]?.text || '(respuesta vacía)'
  const usage = data?.usage || null
  return NextResponse.json({ answer, usage, leadsConsidered: enriched.length })
}
