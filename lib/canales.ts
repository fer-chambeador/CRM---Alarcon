/**
 * Canonical canal names. Any future canal added should be appended here.
 * These map 1:1 to what the user sees in the dropdown filter.
 */
export const CANONICAL_CANALES = [
  'Instagram',
  'TikTok',
  'Facebook',
  'Inbound',
  'Google',
  'Recomendación',
  'LinkedIn',
  'WhatsApp',
] as const

export type CanonicalCanal = typeof CANONICAL_CANALES[number]

/**
 * Normalize raw canal strings to a canonical form.
 *
 * Used in three places:
 *  1. The Supabase migration (one-time UPDATE for existing rows)
 *  2. lib/slack-parser.ts when parsing Slack messages
 *  3. The POST /api/leads and PATCH /api/leads/[id] endpoints
 *
 * Unknown values are preserved as-is (capitalised) so we don't lose data;
 * if you start seeing weird canales in the dropdown, add a rule here.
 */
export function normalizeCanal(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()

  // Instagram (incl. abbreviation 'IG')
  if (lower === 'ig' || lower.includes('instagram')) return 'Instagram'

  // TikTok
  if (lower.includes('tiktok') || lower.includes('tik tok')) return 'TikTok'

  // Inbound (incl. "Fer - Inbound" and other "*-Inbound" variants)
  if (lower.includes('inbound')) return 'Inbound'

  // Facebook
  if (lower === 'fb' || lower.includes('facebook')) return 'Facebook'

  // Google (Ads, organic, etc.)
  if (lower.includes('google')) return 'Google'

  // Recomendación / referral
  if (lower.includes('recomenda') || lower.includes('referral')) return 'Recomendación'

  // LinkedIn
  if (lower.includes('linkedin')) return 'LinkedIn'

  // WhatsApp
  if (lower === 'wa' || lower.includes('whatsapp')) return 'WhatsApp'

  // Unknown — preserve as-is so we don't drop data, but title-case
  return trimmed
}
