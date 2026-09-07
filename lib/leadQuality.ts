import type { Lead } from './supabase'

/**
 * Criterio ÚNICO de "lead calificable". Lo usan /analytics y el KPI
 * "Total leads" del CRM, para que los dos números siempre cuadren.
 *
 * 7-sep-2026 (Fer): "que se borren del # de leads pero que se queden en el CRM".
 *
 * Un lead NO CALIFICABLE es alguien que nunca fue un lead de verdad: entró por
 * el WhatsApp de Vambe (email placeholder <telefono>@clientes.chambas.ai), no
 * dejó NI UNA señal de ser empleador — sin empresa, sin vacante, sin
 * presupuesto, sin puesto y sin notas del formulario — y ADEMÁS nunca avanzó en
 * el pipeline. En la práctica son las personas que buscan chamba, no quien
 * contrata.
 *
 * CUALQUIER señal lo salva: el criterio es estricto a propósito para no sacar
 * del conteo a una empresa real que llenó poco.
 *
 * OJO — no es lo mismo que "descartado". Una empresa real que se trabajó y no
 * cerró SÍ cuenta como lead aunque esté descartada: quitarla del denominador
 * inflaría la conversión (tendería a 100%). Acá solo sale el ruido.
 *
 * Alcance: solo CONTEOS. Estos leads siguen existiendo, visibles y buscables en
 * la lista del CRM — no se borra nada de la base.
 */

/**
 * Cualquier avance real en el pipeline salva al lead SIEMPRE, tenga o no datos
 * capturados. Si agendó llamada, recibió propuesta o pagó, es un lead de verdad.
 *
 * (Aprendido a la mala el 7-sep-2026: la primera versión del filtro solo miraba
 * los campos del formulario y se comió a Luis Rodriguez y Dash Dance, que tenían
 * llamada agendada ese mismo lunes.)
 */
const STATUS_CON_AVANCE: Array<Lead['status']> = [
  'llamada_agendada',
  'no_show_llamada',
  'llamada_con_dapta',
  'presentacion_enviada',
  'espera_aprobacion',
  'liga_pago_enviada',
  'convertido',
  'cliente_recurrente',
]

type LeadCalificable = Pick<Lead,
  'llamada_at' | 'status' | 'email' | 'empresa' | 'vacante' | 'presupuesto' | 'puesto' | 'notas'
>

export function esLeadNoCalificable(lead: LeadCalificable): boolean {
  if (lead.llamada_at) return false
  if (STATUS_CON_AVANCE.includes(lead.status)) return false

  const email = (lead.email || '').toLowerCase().trim()
  if (!email.endsWith('@clientes.chambas.ai')) return false

  const vacio = (v: unknown) => v === null || v === undefined || String(v).trim() === ''
  return vacio(lead.empresa)
    && vacio(lead.vacante)
    && vacio(lead.presupuesto)
    && vacio(lead.puesto)
    && vacio(lead.notas)
}

/** Azúcar: filtra una lista dejando solo los leads que sí cuentan. */
export function soloCalificables<T extends LeadCalificable>(leads: T[]): T[] {
  return leads.filter(l => !esLeadNoCalificable(l))
}
