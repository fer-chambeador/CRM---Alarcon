import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * GET /api/leads/search?q=<query>&limit=10
 *
 * Búsqueda rápida de leads para el modal de "Disparar llamada".
 * Matchea por nombre, email, empresa o teléfono (last10 digits).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const q = (url.searchParams.get('q') || '').trim()
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50)

  if (!q || q.length < 2) {
    return NextResponse.json({ leads: [] })
  }

  const supabase = createServiceClient()

  // Match parcial — case-insensitive — en varias columnas + last10 phone
  const phoneDigits = q.replace(/\D/g, '')
  const isPhoneQuery = phoneDigits.length >= 7

  let query = supabase
    .from('leads')
    .select('id, nombre, email, empresa, telefono, status')
    .limit(limit)
    .order('created_at', { ascending: false })

  if (isPhoneQuery) {
    const last10 = phoneDigits.slice(-10)
    query = query.like('telefono', `%${last10}%`)
  } else {
    // ILIKE across nombre / email / empresa via .or()
    const safe = q.replace(/[%,]/g, '')
    query = query.or(`nombre.ilike.%${safe}%,email.ilike.%${safe}%,empresa.ilike.%${safe}%`)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ leads: data || [] })
}
