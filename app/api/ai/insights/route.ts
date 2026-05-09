import { NextResponse } from 'next/server'
import { createServiceClient, type Lead } from '@/lib/supabase'
import { computeInsightInputs, INSIGHTS_SYSTEM_PROMPT } from '@/lib/insights'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'

export async function GET() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({
      error: 'Falta ANTHROPIC_API_KEY en Railway → Variables.',
    }, { status: 500 })
  }

  const supabase = createServiceClient()
  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(2000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const stats = computeInsightInputs((leads || []) as Lead[])

  const userMsg = `Stats actuales del CRM:\n\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\`\n\nDame 3-5 insights útiles.`

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system: INSIGHTS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    return NextResponse.json({ error: `Anthropic ${res.status}: ${text.slice(0, 200)}` }, { status: 502 })
  }
  const data = await res.json()
  const insights: string = data?.content?.[0]?.text || ''
  return NextResponse.json({ insights, stats, generated_at: new Date().toISOString() })
}
