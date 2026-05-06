/**
 * Mexican LADA (area code) → city/state lookup.
 * Covers ~90% of business volume. Add more as you find gaps in the data.
 */

const TWO_DIGIT = new Set(['55', '33', '81'])

const LADA: Record<string, string> = {
  // 2-digit (top 3 metros)
  '55': 'CDMX',
  '33': 'Guadalajara',
  '81': 'Monterrey',

  // 3-digit
  '222': 'Puebla',
  '228': 'Xalapa',
  '229': 'Veracruz',
  '231': 'Orizaba',
  '241': 'Tlaxcala',
  '244': 'Atlixco',
  '247': 'Tehuacán',
  '311': 'Tepic',
  '312': 'Colima',
  '314': 'Manzanillo',
  '341': 'Sahuayo',
  '442': 'Querétaro',
  '443': 'Morelia',
  '444': 'San Luis Potosí',
  '449': 'Aguascalientes',
  '461': 'Celaya',
  '462': 'Irapuato',
  '464': 'Salamanca',
  '477': 'León',
  '492': 'Zacatecas',
  '614': 'Chihuahua',
  '618': 'Durango',
  '622': 'Guaymas',
  '631': 'Nogales',
  '637': 'Caborca',
  '644': 'Cd. Obregón',
  '662': 'Hermosillo',
  '664': 'Tijuana',
  '686': 'Mexicali',
  '722': 'Toluca',
  '744': 'Acapulco',
  '746': 'Iguala',
  '767': 'Cuautla',
  '777': 'Cuernavaca',
  '844': 'Saltillo',
  '867': 'Nuevo Laredo',
  '871': 'Torreón',
  '899': 'Reynosa',
  '921': 'Coatzacoalcos',
  '951': 'Oaxaca',
  '961': 'Tuxtla Gutiérrez',
  '967': 'San Cristóbal',
  '981': 'Campeche',
  '983': 'Chetumal',
  '993': 'Villahermosa',
  '998': 'Cancún',
  '999': 'Mérida',
}

export function phoneToLocation(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 7) return null
  // Strip leading country code 52 if present
  const local = digits.startsWith('52') && digits.length >= 11
    ? digits.slice(-10)
    : digits.slice(-10)
  const p2 = local.slice(0, 2)
  if (TWO_DIGIT.has(p2)) return LADA[p2] || null
  return LADA[local.slice(0, 3)] || null
}
