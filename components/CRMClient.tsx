'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase, type Lead, type LeadActividad } from '@/lib/supabase'
import { format, formatDistanceToNow, startOfDay, startOfWeek, startOfMonth, endOfMonth, subMonths } from 'date-fns'
import { es } from 'date-fns/locale'
import clsx from 'clsx'
import styles from './CRMClient.module.css'
import { Sidebar } from './CommandCenter'
import {
  STATUS_LABELS, STATUS_ORDER, PIPELINE_ACTIVE, PIPELINE_CLOSING, PIPELINE_CLOSED,
  DEFAULT_MONTO, statusColor, fmtMoney,
} from '@/lib/status'
import { phoneToState, ALL_STATES } from '@/lib/lada'
import { PRESUPUESTO_VALUES, PRESUPUESTO_LABELS, PRESUPUESTO_COLORS, fmtPresupuesto } from '@/lib/budget'
import type { Presupuesto } from '@/lib/budget'
import { canReactivateVambe3d, daysSinceContact } from '@/lib/leadVambe'
import { leadScore as leadPriorityScore, scoreBucket, SCORE_BUCKET_COLOR, SCORE_BUCKET_EMOJI } from '@/lib/scoring'
import { daysInCurrentStage, agingBucket, AGING_COLOR, fmtAgingShort } from '@/lib/velocity'
import { goalForPeriod, goalLabel } from '@/lib/goal'
import { rowsToCsv, downloadCsv, exportFilename } from '@/lib/export'

const CONTACTO_LABELS = ['—', '1er contacto', '2do contacto', '3er contacto', 'Descartado por intentos']

/**
 * Audit #7: traduce el error de un fetch fallido a algo accionable.
 * Antes hacíamos alert('Falló: 502') y Fer no sabía qué hacer.
 * Ahora detectamos los casos típicos de Vambe/Dapta y damos contexto + qué hacer.
 */
function explainError(rawError: string | number | undefined, status: number | undefined): string {
  const e = String(rawError || '').toLowerCase()
  if (e.includes('lead sin telefono') || e.includes('no phone')) {
    return 'Este lead no tiene teléfono guardado. Edita el lead y agrega el número antes de mandar.'
  }
  if (e.includes('template') && (e.includes('no configurado') || e.includes('not configured'))) {
    return 'No hay template Vambe configurado. Ve a Settings → Templates outbound y elige uno.'
  }
  if (e.includes('vambe rechaz') || e.includes('rate limit')) {
    return `Vambe rechazó el envío: ${rawError}. Posibles causas: número bloqueado, fuera de ventana 24h, o saturación de templates.`
  }
  if (e.includes('ya enviado recientemente') || e.includes('anti doble-click') || status === 409) {
    return 'Ya mandaste un mensaje hace menos de 2 minutos. Espera para evitar duplicados.'
  }
  if (e.includes('already-called') || e.includes('llamada ya disparada')) {
    return 'Este lead ya tiene una llamada en curso o reciente. Cancela o espera a que termine.'
  }
  // Vambe channel sin phoneId — mostramos el error completo (que incluye las keys
  // que devolvió Vambe) para poder diagnosticar qué campo usar. NO mencionamos
  // Dapta porque este endpoint solo habla con Vambe.
  if (e.includes('web-whatsapp') || e.includes('phoneid')) {
    return `Vambe: ${rawError}. Probablemente tu cuenta no tiene canal WhatsApp QR conectado, solo Business API → necesitas un template aprobado.`
  }
  if (status === 502) {
    return `Vambe no respondió bien: ${rawError || 'sin detalles'}. Reintenta en 30s; si sigue, revisa Settings → Webhooks.`
  }
  if (status === 500 || status === 503) {
    return `Error del servidor: ${rawError || 'desconocido'}. Reintenta. Si sigue, avisa al equipo de tech.`
  }
  return rawError ? `Falló: ${rawError}` : `Falló (${status || 'sin código'}). Reintenta.`
}

function tipoLabel(t: string | null) {
  if (!t) return ''
  return ({
    usuario_nuevo: '👤',
    empresa_creada: '🏢',
    suscripcion_nueva: '💳',
    manual: '✏️',
    pago_confirmado: '💰',
    vambe_form: '💬',     // form de Vambe (Meta ad → conversación AI)
  } as Record<string, string>)[t] ?? ''
}

function formatFecha(dateStr: string) {
  try { return format(new Date(dateStr), "d 'de' MMM, HH:mm", { locale: es }) }
  catch { return '—' }
}

// ─── Date filter ─────────────────────────────────────────────────────────────
type DateRange = 'todo' | 'hoy' | 'semana' | 'mes' | 'mes-pasado' | 'custom'
const DATE_LABELS: Record<DateRange, string> = {
  todo: 'Todo el tiempo',
  hoy: 'Hoy',
  semana: 'Esta semana',
  mes: 'Este mes',
  'mes-pasado': 'Mes pasado',
  custom: 'Rango personalizado…',
}
function dateRangeBounds(range: DateRange, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  const now = new Date()
  switch (range) {
    case 'todo':       return { from: null, to: null }
    case 'hoy':        return { from: startOfDay(now), to: null }
    case 'semana':     return { from: startOfWeek(now, { weekStartsOn: 1 }), to: null }
    case 'mes':        return { from: startOfMonth(now), to: null }
    case 'mes-pasado': {
      const prev = subMonths(now, 1)
      return { from: startOfMonth(prev), to: endOfMonth(prev) }
    }
    case 'custom': {
      // Custom range: from = inicio del día customFrom (00:00 local), to = fin del día customTo (23:59:59 local)
      const from = customFrom ? startOfDay(new Date(customFrom + 'T00:00:00')) : null
      let to: Date | null = null
      if (customTo) {
        const t = new Date(customTo + 'T23:59:59')
        if (!isNaN(t.getTime())) to = t
      }
      return { from, to }
    }
  }
}

// ─── Search (exact substring, case-insensitive) ──────────────────────────────
function leadMatchesQuery(query: string, lead: Lead): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const fields: (string | null | undefined)[] = [
    lead.email, lead.nombre, lead.empresa, lead.telefono,
    lead.canal_adquisicion, lead.puesto, lead.vacante,
  ]
  for (const f of fields) {
    if (f && f.toLowerCase().includes(q)) return true
  }
  // Match especial por teléfono: si query es mayormente dígitos, comparar por últimos 10
  const qDigits = q.replace(/\D/g, '')
  if (qDigits.length >= 7 && lead.telefono) {
    const leadDigits = lead.telefono.replace(/\D/g, '')
    const qLast10 = qDigits.slice(-10)
    const leadLast10 = leadDigits.slice(-10)
    if (leadLast10 && qLast10 && leadLast10.includes(qLast10.slice(-7))) return true
    if (qLast10 && leadLast10.endsWith(qLast10.slice(-Math.min(qLast10.length, leadLast10.length)))) return true
  }
  return false
}

function ContactoSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className={styles.contactoSelector}>
      {CONTACTO_LABELS.map((label, i) => (
        <button
          key={i}
          className={clsx(styles.contactoBtn, value === i && styles.contactoBtnActive)}
          style={i === 0 ? {} : i === CONTACTO_LABELS.length - 1
            ? { '--cc': '#f05a5a' } as React.CSSProperties
            : { '--cc': '#f5c842' } as React.CSSProperties}
          onClick={() => onChange(i)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

// ─── Timeline ────────────────────────────────────────────────────────────────
function ActivityTimeline({ leadId }: { leadId: string }) {
  const [items, setItems] = useState<LeadActividad[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/leads/${leadId}/actividad`)
      .then(r => r.json())
      .then(data => { if (!cancelled) setItems(Array.isArray(data) ? data : []) })
      .catch(() => { if (!cancelled) setError('No se pudo cargar la actividad') })
    return () => { cancelled = true }
  }, [leadId])

  if (error) return <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>
  if (!items) return <div style={{ fontSize: 12, color: 'var(--text3)' }}>Cargando...</div>
  if (items.length === 0) return <div style={{ fontSize: 12, color: 'var(--text3)' }}>Sin actividad registrada todavía.</div>

  return (
    <div className={styles.timeline}>
      {items.map(it => (
        <div key={it.id} className={styles.timelineItem}>
          <div className={styles.timelineDot} />
          <div className={styles.timelineBody}>
            <div className={styles.timelineDesc}>{it.descripcion || it.tipo}</div>
            <div className={styles.timelineMeta}>
              {formatFecha(it.created_at)}
              <span style={{ opacity: 0.6 }}>· hace {formatDistanceToNow(new Date(it.created_at), { locale: es })}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Add Lead Modal ──────────────────────────────────────────────────────────
function AddLeadModal({ onClose, onAdd }: { onClose: () => void; onAdd: (lead: Lead) => void }) {
  const [form, setForm] = useState({
    email: '', nombre: '', empresa: '', telefono: '', puesto: '', canal_adquisicion: '', notas: '',
    monto: DEFAULT_MONTO,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = useCallback(async () => {
    if (!form.email) { setError('El email es requerido'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/leads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json().catch(() => ({}))
      // FIX (4 jun 2026): además de check data.error, verificar res.ok.
      // Sin esto, si la red caía (5xx), el `setSaving(false)` nunca se
      // llamaba y el botón quedaba "Guardando..." infinito.
      if (!res.ok || (data && typeof data === 'object' && 'error' in data)) {
        const msg = (data as { error?: unknown }).error
        setError(typeof msg === 'string' ? msg : `HTTP ${res.status}`)
        return
      }
      onAdd(data); onClose()
    } catch (e) {
      setError(`Error de red: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [form, onAdd, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, save])

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div><div className={styles.modalEmail}>✏️ Agregar lead manualmente</div></div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          {error && <div style={{ color: 'var(--red)', fontSize: 13, background: 'rgba(240,90,90,0.1)', padding: '8px 12px', borderRadius: 8 }}>{error}</div>}
          <div className={styles.fieldGrid}>
            <label><span>Email *</span><input autoFocus value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="email@empresa.com" /></label>
            <label><span>Nombre</span><input value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} placeholder="Nombre completo" /></label>
            <label><span>Empresa</span><input value={form.empresa} onChange={e => setForm(f => ({ ...f, empresa: e.target.value }))} placeholder="Nombre de empresa" /></label>
            <label><span>Teléfono</span><input value={form.telefono} onChange={e => setForm(f => ({ ...f, telefono: e.target.value }))} placeholder="55 XXXX XXXX" /></label>
            <label><span>Puesto / Rol</span><input value={form.puesto} onChange={e => setForm(f => ({ ...f, puesto: e.target.value }))} placeholder="Reclutador, Dueño, etc." /></label>
            <label><span>Canal</span><input value={form.canal_adquisicion} onChange={e => setForm(f => ({ ...f, canal_adquisicion: e.target.value }))} placeholder="Instagram, TikTok, Facebook..." /></label>
            <label><span>Monto pipeline (MXN)</span>
              <input type="number" min={0} value={form.monto}
                onChange={e => setForm(f => ({ ...f, monto: Number(e.target.value) || 0 }))} />
            </label>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Notas</span>
            <textarea value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))} placeholder="Notas sobre este lead..." rows={3} style={{ resize: 'vertical' }} />
          </label>
        </div>
        <div className={styles.modalFooter}>
          <div className={styles.shortcutHint}>⌘S guardar · Esc cerrar</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={styles.cancelBtn} onClick={onClose}>Cancelar</button>
            <button className={styles.saveBtn} onClick={save} disabled={saving}>{saving ? 'Guardando...' : '+ Agregar lead'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Lead Edit Modal ─────────────────────────────────────────────────────────
function LeadModal({ lead, onClose, onSave, onDelete }: {
  lead: Lead; onClose: () => void; onSave: (updated: Lead) => void; onDelete: (id: string) => void
}) {
  const [form, setForm] = useState({
    nombre: lead.nombre || '', empresa: lead.empresa || '', telefono: lead.telefono || '',
    puesto: lead.puesto || '', canal_adquisicion: lead.canal_adquisicion || '',
    status: lead.status, notas: lead.notas || '',
    monto: lead.monto ?? DEFAULT_MONTO,
    estado: lead.estado || '',
    presupuesto: lead.presupuesto || '',
    vacante: lead.vacante || '',
    llamada_at: lead.llamada_at ? lead.llamada_at.slice(0, 16) : '',
  })
  const [contactos, setContactos] = useState(lead.veces_contactado || 0)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [reactivating, setReactivating] = useState(false)

  // Reactivar lead Vambe con plantilla outbound >3d.
  // Confirma con el user antes (texto literal que pidió Fer), llama al endpoint
  // server-side que re-valida y manda por Vambe sendMessage(). El endpoint tiene
  // anti-doble-click de 2 min — el state local solo bloquea el botón mientras
  // está la request en vuelo. Al éxito refresca el lead con onSave (mismo patrón
  // que Guardar) para que la tabla refleje veces_contactado/ultimo_contacto.
  const reactivateVambe3d = async () => {
    if (reactivating) return
    if (!confirm('¿Quieres mandar la plantilla vambe outbound >3 días?')) return
    setReactivating(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}/reactivate-vambe-3d`, { method: 'POST' })
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; lead?: Lead }
      if (!res.ok || !data.ok) {
        alert(`No se pudo enviar la plantilla: ${explainError(data.error, res.status)}`)
        return
      }
      if (data.lead) {
        onSave(data.lead)  // refresca tabla
        // Bump local state para que el modal abierto refleje los cambios sin
        // tener que cerrar+abrir. FIX (9-jun-2026, Fer): antes el form.status
        // se quedaba en el viejo aunque la DB diga 'contactado'.
        setContactos((data.lead.veces_contactado || contactos) as number)
        setForm(f => ({ ...f, status: (data.lead as Lead).status }))
      }
    } catch (e) {
      alert(`Error de red al enviar plantilla: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReactivating(false)
    }
  }

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          estado: form.estado || null,
          presupuesto: form.presupuesto || null,
          vacante: form.vacante || null,
          llamada_at: form.llamada_at ? new Date(form.llamada_at).toISOString() : null,
          veces_contactado: contactos,
        }),
      })
      const data = await res.json().catch(() => ({}))
      // FIX (4 jun 2026): antes hacía onSave(data) + onClose() SIN validar
      // res.ok. Si el backend retornaba 500/400, el modal cerraba con un
      // objeto error como si fuera el lead, corrompiendo el state local y
      // perdiendo los cambios silenciosamente.
      if (!res.ok) {
        const errMsg = (data && typeof data === 'object' && 'error' in data)
          ? String((data as { error: unknown }).error)
          : `HTTP ${res.status}`
        alert(`Error al guardar: ${errMsg}`)
        return  // mantener modal abierto + cambios visibles
      }
      onSave(data)
      onClose()
    } catch (e) {
      alert(`Error de red al guardar: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [lead.id, form, contactos, onSave, onClose])

  const deleteLead = async () => {
    setDeleting(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(`Error al eliminar: ${(data as { error?: string }).error || `HTTP ${res.status}`}`)
        return
      }
      onDelete(lead.id); onClose()
    } catch (e) {
      alert(`Error de red al eliminar: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeleting(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, save])

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div>
            <div className={styles.modalEmail}>
              {tipoLabel(lead.tipo_evento)} {lead.email}
              <a
                href={`/leads/${lead.id}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginLeft: 10, fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}
                title="Ver detalle completo con timeline + botón 'Ir al chat' Vambe"
              >
                Ver detalle ↗
              </a>
              {/* Audit #11: deep-link directo al chat Vambe — Fer cierra ventas vía WhatsApp,
                  evitar los 2-3 clicks para llegar al chat desde aquí. */}
              {lead.telefono && (() => {
                const pipelineId = '66b6ff34-3ec3-4972-8b90-33a3dc4e45fd'
                const contactId = (lead as Lead & { vambe_contact_id?: string }).vambe_contact_id
                const today = new Date().toISOString().slice(0, 10)
                const url = contactId
                  ? `https://app.vambeai.com/pipeline?id=${pipelineId}&startDate=${today}&chatContactId=${contactId}`
                  : `https://app.vambeai.com/pipeline?id=${pipelineId}&startDate=${today}&query=${encodeURIComponent(lead.telefono.replace(/\D/g, '').slice(-10))}`
                return (
                  <a href={url} target="_blank" rel="noopener noreferrer"
                    style={{ marginLeft: 8, fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(34,214,138,0.15)', color: '#22d68a', textDecoration: 'none', fontWeight: 600 }}
                    title="Abrir chat Vambe en pestaña nueva">
                    💬 Vambe ↗
                  </a>
                )
              })()}
            </div>
            <div className={styles.modalMeta}>
              {formatFecha(lead.created_at)}
              <span className={styles.contactBadge}>💵 {fmtMoney(form.monto)}</span>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.fieldGrid}>
            <label><span>Nombre</span><input value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} placeholder="Nombre completo" /></label>
            <label><span>Empresa</span><input value={form.empresa} onChange={e => setForm(f => ({ ...f, empresa: e.target.value }))} placeholder="Nombre de empresa" /></label>
            <label><span>Teléfono</span><input value={form.telefono} onChange={e => setForm(f => ({ ...f, telefono: e.target.value }))} placeholder="55 XXXX XXXX" /></label>
            <label><span>Puesto / Rol</span><input value={form.puesto} onChange={e => setForm(f => ({ ...f, puesto: e.target.value }))} placeholder="Reclutador, Dueño, etc." /></label>
            <label><span>Canal</span><input value={form.canal_adquisicion} onChange={e => setForm(f => ({ ...f, canal_adquisicion: e.target.value }))} placeholder="Instagram, TikTok..." /></label>
            <label><span>Ubicación (estado)</span>
              <select value={form.estado} onChange={e => setForm(f => ({ ...f, estado: e.target.value }))}>
                <option value="">Auto: {phoneToState(form.telefono) || '— sin detectar —'}</option>
                {ALL_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label><span>Presupuesto</span>
              <select value={form.presupuesto} onChange={e => setForm(f => ({ ...f, presupuesto: e.target.value as Presupuesto | '' }))}>
                <option value="">No registrado</option>
                {PRESUPUESTO_VALUES.map(p => <option key={p} value={p}>{PRESUPUESTO_LABELS[p]}</option>)}
              </select>
            </label>
            <label><span>Vacante (puesto buscado)</span>
              <input value={form.vacante} onChange={e => setForm(f => ({ ...f, vacante: e.target.value }))}
                placeholder="Cocinero, Seguridad, Reclutador, etc." />
            </label>
            {form.status === 'llamada_agendada' && (
              <label><span>📞 Fecha y hora de la llamada</span>
                <input type="datetime-local"
                  value={form.llamada_at}
                  onChange={e => setForm(f => ({ ...f, llamada_at: e.target.value }))} />
              </label>
            )}
            <label><span>Monto pipeline (MXN)</span>
              <input type="number" min={0} step={1} value={form.monto}
                onChange={e => setForm(f => ({ ...f, monto: Number(e.target.value) || 0 }))} />
            </label>
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Status</span>
            <div className={styles.statusPicker}>
              {STATUS_ORDER.map(s => (
                <button key={s} className={clsx(styles.statusBtn, form.status === s && styles.statusBtnActive)}
                  style={{ '--sc': statusColor(s) } as React.CSSProperties} onClick={() => setForm(f => ({ ...f, status: s }))}>
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Intentos de contacto</span>
            <ContactoSelector value={contactos} onChange={setContactos} />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Notas</span>
            <textarea value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))} placeholder="Notas sobre este lead..." rows={4} style={{ resize: 'vertical' }} />
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Actividad</span>
            <ActivityTimeline leadId={lead.id} />
          </div>
        </div>
        <div className={styles.modalFooter}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {!confirmDelete
              ? <button className={styles.deleteBtn} onClick={() => setConfirmDelete(true)}>🗑 Eliminar</button>
              : <button className={styles.deleteConfirmBtn} onClick={deleteLead} disabled={deleting}>{deleting ? 'Eliminando...' : '⚠️ Confirmar'}</button>
            }
            <span className={styles.shortcutHint}>⌘S guardar · Esc cerrar</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {/* Botón "Reactivar Vambe >3d" — solo si lead es canal Vambe y lleva
                ≥3 días sin contacto. Confirma con texto literal antes de enviar. */}
            {canReactivateVambe3d(lead) && (() => {
              const d = daysSinceContact(lead)
              const dayLabel = d === null ? null : `${Math.floor(d)}d`
              return (
                <button onClick={reactivateVambe3d} disabled={reactivating}
                  style={{
                    background: reactivating ? 'rgba(124, 84, 232, 0.4)' : 'linear-gradient(135deg, #7c54e8, #5e3dd1)',
                    color: 'white', border: 'none', cursor: reactivating ? 'wait' : 'pointer',
                    padding: '8px 14px', borderRadius: 8,
                    fontSize: 13, fontWeight: 700,
                  }}
                  title={`Manda la plantilla de reactivación por Vambe${dayLabel ? ` — ${dayLabel} sin contacto` : ' (nunca contactado)'}`}>
                  {reactivating ? 'Enviando…' : (dayLabel ? `🔁 Reactivar Vambe (${dayLabel})` : '🔁 Reactivar Vambe')}
                </button>
              )
            })()}
            <button className={styles.cancelBtn} onClick={onClose}>Cancelar</button>
            <button className={styles.saveBtn} onClick={save} disabled={saving}>{saving ? 'Guardando...' : 'Guardar'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Inline status popover ───────────────────────────────────────────────────
function StatusPopover({ current, anchor, onPick, onClose }: {
  current: Lead['status']; anchor: { x: number; y: number };
  onPick: (s: Lead['status']) => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    setTimeout(() => document.addEventListener('mousedown', onClick), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div ref={ref} className={styles.statusPopover} style={{ top: anchor.y, left: anchor.x }}>
      {STATUS_ORDER.map(s => (
        <button key={s} className={clsx(styles.statusPopoverItem, current === s && styles.statusPopoverItemActive)}
          style={{ '--sc': statusColor(s) } as React.CSSProperties}
          onClick={() => onPick(s)}>
          <span className={styles.statusPopoverDot} />
          {STATUS_LABELS[s]}
        </button>
      ))}
    </div>
  )
}

// ─── Sortable header ─────────────────────────────────────────────────────────
type SortKey = 'email' | 'empresa' | 'telefono' | 'ubicacion' | 'canal' | 'status' | 'monto' | 'presupuesto' | 'contacto' | 'fecha' | 'score'
function SortableHeader({ label, sortKey, current, onSort }: {
  label: string; sortKey: SortKey; current: { key: SortKey; dir: 'asc' | 'desc' } | null;
  onSort: (k: SortKey) => void
}) {
  const isActive = current?.key === sortKey
  return (
    <th className={styles.sortHeader} onClick={() => onSort(sortKey)}>
      <span>{label}</span>
      <span className={clsx(styles.sortIcon, isActive && styles.sortIconActive)}>
        {isActive ? (current?.dir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  )
}

// ─── Main CRM ────────────────────────────────────────────────────────────────
export default function CRMClient({ initialLeads }: { initialLeads: Lead[] }) {
  const searchParams = useSearchParams()
  const initialLeadId = searchParams.get('lead')
  const initialNew = searchParams.get('new') === '1'
  // BUG FIX (audit 17-jun-2026): el query param ?q= se ignoraba al cargar
  // la página. Ahora hidratamos el input de búsqueda desde searchParams
  // para que enlaces tipo /leads?q=5513003501 abran ya filtrados.
  const initialQuery = searchParams.get('q') || ''

  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(
    initialLeadId ? initialLeads.find(l => l.id === initialLeadId) || null : null
  )
  const [showAddModal, setShowAddModal] = useState(initialNew)
  const [exportOpen, setExportOpen] = useState(false)
  const [search, setSearch] = useState(initialQuery)
  const [filterStatus, setFilterStatus] = useState<Lead['status'] | 'todos'>('todos')
  const [filterAttempts, setFilterAttempts] = useState<number | 'todos'>('todos')
  const [filterCanal, setFilterCanal] = useState<string>('todos')
  const [dateRange, setDateRange] = useState<DateRange>('mes')
  // Custom date range — solo se usan cuando dateRange === 'custom'.
  // Default: el rango del mes actual (inicio mes → hoy) para que abra con algo útil.
  const todayIso = new Date().toISOString().slice(0, 10)
  const monthStartIso = startOfMonth(new Date()).toISOString().slice(0, 10)
  const [customFrom, setCustomFrom] = useState<string>(monthStartIso)
  const [customTo, setCustomTo] = useState<string>(todayIso)
  const [newLeadFlash, setNewLeadFlash] = useState<string | null>(null)
  const [liveCount, setLiveCount] = useState(0)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>({ key: 'fecha', dir: 'desc' })
  const [popover, setPopover] = useState<{ leadId: string; current: Lead['status']; x: number; y: number } | null>(null)
  // Popup "¿Por dónde lo quieres mandar?" (botón Mensaje) — 8-jul-2026
  const [channelPicker, setChannelPicker] = useState<Lead | null>(null)
  const [channelSending, setChannelSending] = useState<'vambe' | 'wa' | null>(null)

  // Envío por Vambe — mismo flujo de siempre (quick-action 'message').
  const sendChannelVambe = async (lead: Lead) => {
    const res = await fetch(`/api/leads/${lead.id}/quick-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'message' }),
    })
    const data = await res.json()
    if (!data.ok) { alert(explainError(data.error, res.status)); return }
    if (data.lead && data.lead.id) handleSave(data.lead as Lead)
  }

  // Envío por WhatsApp directo de Fer (WA Bridge) — misma plantilla, 1×1.
  const sendChannelWa = async (lead: Lead) => {
    const res = await fetch(`/api/leads/${lead.id}/wa-direct`, { method: 'POST' })
    const data = await res.json()
    if (!data.ok) { alert(explainError(data.error, res.status)); return }
    if (data.lead && data.lead.id) handleSave(data.lead as Lead)
  }

  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const channel = supabase.channel('leads-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newLead = payload.new as Lead
          // De-duplicar: si el lead ya está en el state (porque handleAdd lo
          // agregó al recibir la respuesta del POST), no lo dupliques. Race
          // condition común: el POST devuelve el lead Y realtime dispara
          // INSERT casi simultáneo — uno de los dos llega primero, el otro
          // tiene que respetar.
          setLeads(prev => prev.some(l => l.id === newLead.id) ? prev : [newLead, ...prev])
          setNewLeadFlash(newLead.email)
          setLiveCount(c => c + 1)
          setTimeout(() => setNewLeadFlash(null), 3000)
        } else if (payload.eventType === 'UPDATE') {
          const updated = payload.new as Lead
          setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))
          if (selectedLead?.id === updated.id) setSelectedLead(updated)
        } else if (payload.eventType === 'DELETE') {
          const id = (payload.old as Lead).id
          setLeads(prev => prev.filter(l => l.id !== id))
        }
      }).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [selectedLead])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable
      if (inField) return
      if (e.key === '/') { e.preventDefault(); searchInputRef.current?.focus() }
      if (e.key === 'n') { e.preventDefault(); setShowAddModal(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleSave = useCallback((updated: Lead) => {
    setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))
  }, [])
  const handleDelete = useCallback((id: string) => { setLeads(prev => prev.filter(l => l.id !== id)) }, [])
  const handleAdd = useCallback((lead: Lead) => {
    // De-duplicar: si el realtime listener ya añadió el lead (puede llegar
    // antes que la respuesta del POST), no lo agregues otra vez.
    setLeads(prev => prev.some(l => l.id === lead.id) ? prev : [lead, ...prev])
  }, [])

  const updateStatus = useCallback(async (leadId: string, newStatus: Lead['status']) => {
    // Audit #4: si descartamos, pedir razón para análisis cualitativo posterior.
    // Capturamos el motivo en notas para que /analytics pueda agruparlo.
    let descartadoNota: string | null = null
    if (newStatus === 'descartado') {
      const lead = leads.find(l => l.id === leadId)
      const opts = [
        '1. No le interesa',
        '2. No contesta',
        '3. Mal teléfono',
        '4. Es candidato (no empresa)',
        '5. Otro',
      ].join('\n')
      const choice = prompt(`Razón para descartar a ${lead?.nombre || lead?.email || 'este lead'}?\n\n${opts}\n\nEscribe el número o el motivo libre:`)
      if (choice === null) return  // user canceló
      const cleaned = (choice || '').trim()
      if (!cleaned) return
      const mapped =
        cleaned === '1' ? 'No le interesa' :
        cleaned === '2' ? 'No contesta' :
        cleaned === '3' ? 'Mal teléfono' :
        cleaned === '4' ? 'Es candidato (no empresa)' :
        cleaned === '5' ? 'Otro' :
        cleaned
      const stamp = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })
      descartadoNota = `[${stamp}] Descartado — ${mapped}`
    }
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: newStatus } : l))
    try {
      const body: Record<string, unknown> = { status: newStatus }
      if (descartadoNota) {
        const lead = leads.find(l => l.id === leadId)
        const prevNotas = lead?.notas?.trim() || ''
        body.notas = prevNotas ? `${prevNotas}\n${descartadoNota}` : descartadoNota
      }
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const updated = await res.json()
      if (updated && updated.id) setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))
    } catch {}
  }, [leads])

  const dateScoped = useMemo(() => {
    const { from, to } = dateRangeBounds(dateRange, customFrom, customTo)
    if (!from && !to) return leads
    return leads.filter(l => {
      const t = new Date(l.created_at).getTime()
      if (from && t < from.getTime()) return false
      if (to && t > to.getTime()) return false
      return true
    })
  }, [leads, dateRange, customFrom, customTo])

  const filtered = useMemo(() => {
    const q = search.trim()
    return dateScoped.filter(lead => {
      const matchStatus = filterStatus === 'todos' || lead.status === filterStatus
      const matchCanal = filterCanal === 'todos' || lead.canal_adquisicion === filterCanal
      const matchAttempts = filterStatus !== 'contactado' || filterAttempts === 'todos'
        || (lead.veces_contactado || 0) === filterAttempts
      const matchSearch = !q || leadMatchesQuery(q, lead)
      return matchStatus && matchCanal && matchAttempts && matchSearch
    })
  }, [dateScoped, search, filterStatus, filterAttempts, filterCanal])

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const get = (l: Lead): string | number => {
      switch (sort.key) {
        case 'email': return (l.nombre || l.email).toLowerCase()
        case 'empresa': return (l.empresa || '').toLowerCase()
        case 'telefono': return l.telefono || ''
        case 'canal': return l.canal_adquisicion || ''
        case 'ubicacion': return l.estado || phoneToState(l.telefono) || ''
        case 'status': return STATUS_ORDER.indexOf(l.status)
        case 'monto': return l.monto ?? 0
        case 'score': return leadPriorityScore(l)
        case 'presupuesto': {
          // Sort by tier rank: null < none < 100_to_1000 < 2000_to_5000 < 10000_plus
          const rank: Record<string, number> = { none: 1, '100_to_1000': 2, '2000_to_5000': 3, '10000_plus': 4 }
          return l.presupuesto ? (rank[l.presupuesto] || 0) : -1
        }
        case 'contacto': return l.veces_contactado || 0
        case 'fecha': return l.created_at
      }
    }
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = get(a), bv = get(b)
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
  }, [filtered, sort])

  const onSort = (key: SortKey) => {
    setSort(s => s?.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'fecha' || key === 'contacto' || key === 'monto' || key === 'score' ? 'desc' : 'asc' })
  }

  // Render completo — sin paginación (con 400-1000 leads el navegador maneja bien).
  // Si llegamos a >2k leads, evaluamos virtualizar.
  const visibleSorted = sorted

  const stats = useMemo(() => {
    const sumMonto = (rows: Lead[]) => rows.reduce((acc, l) => acc + (l.monto ?? DEFAULT_MONTO), 0)
    const cerrados = dateScoped.filter(l => PIPELINE_CLOSED.includes(l.status))
    return {
      leads: dateScoped.length,
      pipelineActivo: sumMonto(dateScoped.filter(l => PIPELINE_ACTIVE.includes(l.status))),
      pipelineCierre: sumMonto(dateScoped.filter(l => PIPELINE_CLOSING.includes(l.status))),
      pipelineCerrado: sumMonto(cerrados),
      pipelineCerradoCount: cerrados.length,
    }
  }, [dateScoped])
  const periodGoal = goalForPeriod(dateRange)

  // Build CSV de leads — usado por el modal de export.
  const buildLeadsCsv = useCallback((leads: Lead[]) => {
    const headers = [
      'Nombre', 'Email', 'Empresa', 'Teléfono', 'Ubicación',
      'Status', 'Intentos de contacto', 'Días sin contactar',
      'Canal', 'Puesto', 'Vacante', 'Presupuesto',
      'Monto', 'Fecha de creación', 'Última actualización',
      'Notas',
    ]
    const rows = leads.map(l => [
      l.nombre || '',
      l.email,
      l.empresa || '',
      l.telefono || '',
      l.estado || phoneToState(l.telefono) || '',
      STATUS_LABELS[l.status],
      l.veces_contactado || 0,
      Math.round(daysInCurrentStage(l)),
      l.canal_adquisicion || '',
      l.puesto || '',
      l.vacante || '',
      l.presupuesto ? PRESUPUESTO_LABELS[l.presupuesto as Presupuesto] : '',
      l.monto ?? DEFAULT_MONTO,
      l.created_at ? new Date(l.created_at).toLocaleString('es-MX') : '',
      l.updated_at ? new Date(l.updated_at).toLocaleString('es-MX') : '',
      l.notas || '',
    ])
    return rowsToCsv(headers, rows)
  }, [])

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="leads" />
        {liveCount > 0 && <div className={styles.livePill}><span className={styles.liveDot} />{liveCount} nuevo{liveCount > 1 ? 's' : ''} en vivo</div>}

        <div style={{ padding: '14px 14px 10px' }}>
          <button className={styles.addLeadBtn} onClick={() => setShowAddModal(true)}>+ Agregar lead</button>
        </div>

        <div className={styles.filterSection}>
          <div className={styles.filterLabel}>Filtrar por status</div>
          {(['todos', ...STATUS_ORDER] as const).map(s => (
            <div key={s}>
              <button className={clsx(styles.filterBtn, filterStatus === s && styles.filterBtnActive)}
                onClick={() => { setFilterStatus(s); if (s !== 'contactado') setFilterAttempts('todos') }}
                style={s !== 'todos' ? { '--sc': statusColor(s as Lead['status']) } as React.CSSProperties : {}}>
                {s === 'todos' ? 'Todos' : STATUS_LABELS[s as Lead['status']]}
                <span className={styles.filterCount}>
                  {s === 'todos' ? dateScoped.length : dateScoped.filter(l => l.status === s).length}
                </span>
              </button>
              {s === 'contactado' && filterStatus === 'contactado' && (
                <div className={styles.subFilter}>
                  <button className={clsx(styles.subFilterBtn, filterAttempts === 'todos' && styles.subFilterBtnActive)}
                    onClick={() => setFilterAttempts('todos')}>
                    Todos<span className={styles.filterCount}>{dateScoped.filter(l => l.status === 'contactado').length}</span>
                  </button>
                  {[1, 2, 3].map(n => (
                    <button key={n}
                      className={clsx(styles.subFilterBtn, filterAttempts === n && styles.subFilterBtnActive)}
                      onClick={() => setFilterAttempts(n)}>
                      {n}{n === 1 ? 'er' : n === 2 ? 'do' : 'er'} contacto
                      <span className={styles.filterCount}>
                        {dateScoped.filter(l => l.status === 'contactado' && (l.veces_contactado || 0) === n).length}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

      </aside>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <h1 className={styles.pageTitle}>Leads</h1>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>🔍</span>
            <input ref={searchInputRef} className={styles.searchInput} type="text"
              placeholder="Buscar (atajo: / )" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className={styles.dateSelect} value={dateRange} onChange={e => setDateRange(e.target.value as DateRange)}>
            {(Object.keys(DATE_LABELS) as DateRange[]).map(r => (
              <option key={r} value={r}>{DATE_LABELS[r]}</option>
            ))}
          </select>
          {dateRange === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={e => setCustomFrom(e.target.value)}
                style={{
                  background: 'var(--glass)', border: '1px solid var(--border2)',
                  color: 'var(--text2)', padding: '7px 10px', borderRadius: 'var(--radius-pill)',
                  fontSize: 12, fontFamily: 'var(--font)', colorScheme: 'dark',
                }}
                aria-label="Desde"
                title="Desde"
              />
              <span style={{ color: 'var(--text3)', fontSize: 12 }}>→</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={e => setCustomTo(e.target.value)}
                style={{
                  background: 'var(--glass)', border: '1px solid var(--border2)',
                  color: 'var(--text2)', padding: '7px 10px', borderRadius: 'var(--radius-pill)',
                  fontSize: 12, fontFamily: 'var(--font)', colorScheme: 'dark',
                }}
                aria-label="Hasta"
                title="Hasta"
              />
            </div>
          )}
          <button onClick={() => setExportOpen(true)}
            title="Afina y descarga los leads visibles en formato CSV/Excel"
            style={{
              background: 'var(--glass)', border: '1px solid var(--border2)',
              color: 'var(--text2)', padding: '9px 16px', borderRadius: 'var(--radius-pill)',
              fontSize: 12.5, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font)',
              whiteSpace: 'nowrap',
            }}>
            ⇣ Excel ({sorted.length})
          </button>
          <div className={styles.topBarRight}>
            <div className={styles.liveIndicator}><span className={styles.liveDotGreen} />En vivo desde Slack</div>
          </div>
        </div>

        <div className={styles.kpiHero}>
          <div className={clsx(styles.kpiHeroCard, styles.kpiHeroPurple)}>
            <div className={styles.kpiHeroLabel}>Total leads</div>
            <div className={styles.kpiHeroValue}>{stats.leads}</div>
            <div className={styles.kpiHeroSub}>{DATE_LABELS[dateRange]}</div>
          </div>
          <div className={clsx(styles.kpiHeroCard, styles.kpiHeroTeal)}>
            <div className={styles.kpiHeroLabel}>Pipeline del periodo</div>
            <div className={styles.kpiHeroValue}>{fmtMoney(stats.pipelineActivo)}</div>
            <div className={styles.kpiHeroSub}>Nuevo, contactado, llamada agendada, no show</div>
          </div>
          <div className={clsx(styles.kpiHeroCard, styles.kpiHeroIndigo)}>
            <div className={styles.kpiHeroLabel}>Pipeline por cerrar</div>
            <div className={styles.kpiHeroValue}>{fmtMoney(stats.pipelineCierre)}</div>
            <div className={styles.kpiHeroSub}>Propuesta + Espera de aprobación + Liga de pago</div>
          </div>
          <div className={clsx(styles.kpiHeroCard, styles.kpiHeroDark)}>
            <div className={styles.kpiHeroLabel}>Pipeline cerrado</div>
            <div className={styles.kpiHeroValue}>{fmtMoney(stats.pipelineCerrado)}</div>
            <div className={styles.kpiHeroSub}>
              {stats.pipelineCerradoCount} deals · {goalLabel(dateRange)} {fmtMoney(periodGoal)}
              {' '}({periodGoal > 0 ? Math.round(Math.min(1, stats.pipelineCerrado / periodGoal) * 100) : 0}%)
            </div>
            <div className={styles.kpiHeroBar}>
              <div className={styles.kpiHeroBarFill}
                style={{ width: `${periodGoal > 0 ? Math.min(100, (stats.pipelineCerrado / periodGoal) * 100) : 0}%` }} />
            </div>
          </div>
        </div>

        {newLeadFlash && <div className={styles.flashBanner}>🆕 Nuevo lead: <strong>{newLeadFlash}</strong></div>}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <SortableHeader label="Lead" sortKey="email" current={sort} onSort={onSort} />
                <SortableHeader label="Empresa" sortKey="empresa" current={sort} onSort={onSort} />
                <SortableHeader label="Teléfono" sortKey="telefono" current={sort} onSort={onSort} />
                <SortableHeader label="Ubicación" sortKey="ubicacion" current={sort} onSort={onSort} />
                <SortableHeader label="Canal" sortKey="canal" current={sort} onSort={onSort} />
                <SortableHeader label="Status" sortKey="status" current={sort} onSort={onSort} />
                <SortableHeader label="Monto" sortKey="monto" current={sort} onSort={onSort} />
                <SortableHeader label="Presupuesto" sortKey="presupuesto" current={sort} onSort={onSort} />
                <SortableHeader label="Contacto" sortKey="contacto" current={sort} onSort={onSort} />
                <SortableHeader label="Fecha" sortKey="fecha" current={sort} onSort={onSort} />
                <th style={{ width: 180 }}>Acciones</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--text3)', padding: '40px 0' }}>No hay leads que coincidan</td></tr>}
              {visibleSorted.map(lead => {
                const isNew = newLeadFlash === lead.email
                const contactoLabel = CONTACTO_LABELS[Math.min(lead.veces_contactado || 0, CONTACTO_LABELS.length - 1)]
                const isDescartadoPorIntentos = (lead.veces_contactado || 0) >= CONTACTO_LABELS.length - 1
                const score = leadPriorityScore(lead)
                const bucket = scoreBucket(score)
                return (
                  <tr key={lead.id} className={clsx(styles.row, isNew && styles.rowFlash)}
                      onClick={() => setSelectedLead(lead)}>
                    <td>
                      <div className={styles.emailCell}>
                        <span className={styles.tipoIcon}>{tipoLabel(lead.tipo_evento)}</span>
                        <div>
                          <div className={styles.leadName} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className={styles.scorePill}
                              style={{ '--sc': SCORE_BUCKET_COLOR[bucket] } as React.CSSProperties}
                              title={`Score ${score} · ${bucket}`}>
                              {SCORE_BUCKET_EMOJI[bucket]} {score}
                            </span>
                            {lead.nombre || ''}
                          </div>
                          <div className={styles.leadEmail}>{lead.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className={styles.empresaCell} onClick={e => e.stopPropagation()}>
                      {lead.empresa
                        ? <span className={styles.empresaCopy} onClick={() => navigator.clipboard.writeText(lead.empresa!)} title="Click para copiar">
                            {lead.empresa} <span className={styles.copyIcon}>📋</span>
                          </span>
                        : <span className={styles.empty}>—</span>}
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      {lead.telefono
                        ? <span className={styles.telefonoCell} onClick={() => navigator.clipboard.writeText(lead.telefono!)} title="Click para copiar">
                            {lead.telefono} <span className={styles.copyIcon}>📋</span>
                          </span>
                        : <span className={styles.empty}>—</span>}
                    </td>
                    <td>{(lead.estado || phoneToState(lead.telefono))
                      ? <span className={styles.ubicacionTag} title={lead.estado ? 'manual' : 'auto desde LADA'}>{lead.estado || phoneToState(lead.telefono)}</span>
                      : <span className={styles.empty}>—</span>}</td>
                    <td>{lead.canal_adquisicion ? <span className={styles.canalTag}>{lead.canal_adquisicion}</span> : <span className={styles.empty}>—</span>}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <button className={styles.statusInlineBtn}
                          title="Click para cambiar status"
                          onClick={(e) => {
                            const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                            setPopover({ leadId: lead.id, current: lead.status, x: r.left + window.scrollX, y: r.bottom + window.scrollY + 4 })
                          }}>
                          <span className={styles.statusTag} style={{ '--sc': statusColor(lead.status) } as React.CSSProperties}>{STATUS_LABELS[lead.status]}</span>
                          <span className={styles.statusInlineCaret}>▾</span>
                        </button>
                        {!PIPELINE_CLOSED.includes(lead.status) && lead.status !== 'descartado' && (() => {
                          const d = daysInCurrentStage(lead)
                          const ab = agingBucket(d)
                          return (
                            <span className={styles.agingChip}
                              style={{ '--ac': AGING_COLOR[ab] } as React.CSSProperties}
                              title={`${Math.round(d)} días en ${STATUS_LABELS[lead.status]}`}>
                              ⏱ {fmtAgingShort(d)}
                            </span>
                          )
                        })()}
                      </div>
                    </td>
                    <td className={styles.montoCell}>{fmtMoney(lead.monto ?? DEFAULT_MONTO)}</td>
                    <td>
                      {lead.presupuesto
                        ? <span className={styles.presupuestoTag}
                            style={{ '--pc': PRESUPUESTO_COLORS[lead.presupuesto as Presupuesto] } as React.CSSProperties}>
                            {fmtPresupuesto(lead.presupuesto)}
                          </span>
                        : <span className={styles.empty}>No registrado</span>}
                    </td>
                    <td>
                      {(lead.veces_contactado || 0) > 0
                        ? <span className={styles.contactCount} style={{ color: isDescartadoPorIntentos ? 'var(--red)' : 'var(--yellow)' }}>{contactoLabel}</span>
                        : <span className={styles.empty}>—</span>}
                    </td>
                    <td className={styles.timeCell}>{formatFecha(lead.created_at)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {(() => {
                          // 9-jun-2026 (Fer): el botón "Mensaje" se transforma en
                          // "Reactivar Vambe" cuando el lead aplica (canal Vambe + ≥3d
                          // sin contacto). Mismo botón en la tabla — sin escondidos.
                          const isReactivar = canReactivateVambe3d(lead)
                          const d = daysSinceContact(lead)
                          const dayLabel = d === null ? null : `${Math.floor(d)}d`
                          return (
                            <button
                              title={!lead.telefono ? 'lead sin teléfono'
                                : isReactivar ? `Mandar plantilla de reactivación Vambe${dayLabel ? ` (${dayLabel} sin contacto)` : ' (nunca contactado)'}`
                                : `Mandar mensaje Vambe a ${lead.telefono}`}
                              disabled={!lead.telefono}
                              onClick={async () => {
                                if (isReactivar) {
                                  if (!confirm('¿Quieres mandar la plantilla vambe outbound >3 días?')) return
                                  const res = await fetch(`/api/leads/${lead.id}/reactivate-vambe-3d`, { method: 'POST' })
                                  const data = await res.json().catch(() => ({}))
                                  if (!res.ok || !data.ok) { alert(explainError(data.error, res.status)); return }
                                  if (data.lead?.id) handleSave(data.lead as Lead)
                                  return
                                }
                                // 8-jul-2026 (Fer): popup de canal — "¿Por dónde lo quieres
                                // mandar?" Vambe (flujo de siempre) o WhatsApp directo de Fer
                                // (WA Bridge). Los grandes los atiende Fer desde su WB.
                                setChannelPicker(lead)
                              }}
                              style={{
                                background: isReactivar
                                  ? 'linear-gradient(135deg, #7c54e8, #5e3dd1)'  // morado para reactivar
                                  : 'linear-gradient(135deg, #22d68a, #1ab574)', // verde para mensaje normal
                                color: 'white', border: 'none',
                                padding: '4px 10px', borderRadius: 6,
                                fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                opacity: lead.telefono ? 1 : 0.4,
                              }}>{isReactivar ? (dayLabel ? `🔁 Reactivar Vambe (${dayLabel})` : '🔁 Reactivar Vambe') : '📨 Mensaje'}</button>
                          )
                        })()}
                        {/* 17-jul-2026 (Fer): Dapta/Daniela fuera de operación — botón
                            Llamar OCULTO (no eliminado, por si Dapta regresa). Para
                            reactivarlo: cambiar false → true. */}
                        {(false as boolean) && <button
                          title={lead.telefono ? `Disparar llamada Daniela a ${lead.telefono}` : 'lead sin teléfono'}
                          disabled={!lead.telefono}
                          onClick={async () => {
                            if (!confirm(`¿Disparar llamada de Daniela (Dapta) a ${lead.nombre || lead.email}?`)) return
                            const res = await fetch(`/api/leads/${lead.id}/quick-action`, {
                              method: 'POST',
                              headers: { 'content-type': 'application/json' },
                              body: JSON.stringify({ action: 'call' }),
                            })
                            const data = await res.json()
                            if (!data.ok) { alert(explainError(data.error, res.status)); return }
                            // Audit #5: el endpoint ahora devuelve el lead, no necesitamos refetch.
                            if (data.lead && data.lead.id) handleSave(data.lead as Lead)
                          }}
                          style={{
                            background: 'linear-gradient(135deg, #7c54e8, #5a8af0)',
                            color: 'white', border: 'none',
                            padding: '4px 10px', borderRadius: 6,
                            fontSize: 11, fontWeight: 600, cursor: 'pointer',
                            opacity: lead.telefono ? 1 : 0.4,
                          }}>📞 Llamar</button>}
                      </div>
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className={styles.rowDeleteBtn} onClick={async () => {
                        if (!confirm(`¿Eliminar ${lead.email}?`)) return
                        await fetch(`/api/leads/${lead.id}`, { method: 'DELETE' })
                        handleDelete(lead.id)
                      }}>🗑</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </main>

      {selectedLead && <LeadModal lead={selectedLead} onClose={() => setSelectedLead(null)} onSave={handleSave} onDelete={handleDelete} />}
      {showAddModal && <AddLeadModal onClose={() => setShowAddModal(false)} onAdd={handleAdd} />}
      {channelPicker && (
        <div className={styles.modalOverlay} onClick={() => { if (!channelSending) setChannelPicker(null) }}>
          <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalEmail}>📨 ¿Por dónde lo quieres mandar?</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  {(channelPicker.empresa || channelPicker.nombre || channelPicker.email) ?? ''} · {channelPicker.telefono}
                </div>
              </div>
            </div>
            <div className={styles.modalBody}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button
                  disabled={!!channelSending}
                  onClick={async () => {
                    setChannelSending('vambe')
                    try { await sendChannelVambe(channelPicker) } finally { setChannelSending(null); setChannelPicker(null) }
                  }}
                  style={{
                    background: 'linear-gradient(135deg, #7c54e8, #5e3dd1)', color: 'white',
                    border: 'none', padding: '12px 16px', borderRadius: 8, fontSize: 14,
                    fontWeight: 700, cursor: 'pointer', opacity: channelSending && channelSending !== 'vambe' ? 0.5 : 1,
                  }}>
                  {channelSending === 'vambe' ? 'Enviando por Vambe…' : '💬 1. Vambe (IA da seguimiento)'}
                </button>
                <button
                  disabled={!!channelSending}
                  onClick={async () => {
                    setChannelSending('wa')
                    try { await sendChannelWa(channelPicker) } finally { setChannelSending(null); setChannelPicker(null) }
                  }}
                  style={{
                    background: 'linear-gradient(135deg, #22d68a, #1ab574)', color: 'white',
                    border: 'none', padding: '12px 16px', borderRadius: 8, fontSize: 14,
                    fontWeight: 700, cursor: 'pointer', opacity: channelSending && channelSending !== 'wa' ? 0.5 : 1,
                  }}>
                  {channelSending === 'wa' ? 'Enviando desde tu WhatsApp…' : '🟢 2. WhatsApp (desde tu WB, tú das seguimiento)'}
                </button>
                <button
                  disabled={!!channelSending}
                  onClick={() => setChannelPicker(null)}
                  style={{
                    background: 'transparent', color: 'var(--text-dim, #999)',
                    border: '1px solid rgba(255,255,255,0.15)', padding: '8px 16px',
                    borderRadius: 8, fontSize: 13, cursor: 'pointer',
                  }}>
                  Cancelar
                </button>
              </div>
              <div style={{ fontSize: 11, opacity: 0.55, marginTop: 12, lineHeight: 1.5 }}>
                Ambas opciones mandan la misma plantilla con el nombre de la empresa.
                Vambe: la IA contesta y agenda. WhatsApp: sale de tu número vía WA Bridge y tú contestas.
              </div>
            </div>
          </div>
        </div>
      )}
      {exportOpen && (
        <ExportModal
          leads={sorted}
          onClose={() => setExportOpen(false)}
          onDownload={(subset) => {
            const csv = buildLeadsCsv(subset)
            downloadCsv(exportFilename('Leads'), csv)
            setExportOpen(false)
          }}
        />
      )}
      {popover && (
        <StatusPopover current={popover.current} anchor={{ x: popover.x, y: popover.y }}
          onPick={(s) => { updateStatus(popover.leadId, s); setPopover(null) }}
          onClose={() => setPopover(null)} />
      )}
    </div>
  )
}

// ─── Export Modal ────────────────────────────────────────────────────────────
// Buckets de "días sin contactar" usados solo en el modal de export.
// Independientes del aging chip de la tabla (que usa otra escala).
const EXPORT_AGING_BUCKETS: Array<{ value: string; label: string; test: (d: number) => boolean }> = [
  { value: 'd0-3',     label: '0-3 días',   test: d => d >= 0 && d <= 3 },
  { value: 'd4-6',     label: '4-6 días',   test: d => d >= 4 && d <= 6 },
  { value: 'd7-10',    label: '7-10 días',  test: d => d >= 7 && d <= 10 },
  { value: 'd11-15',   label: '11-15 días', test: d => d >= 11 && d <= 15 },
  { value: 'd_over15', label: '>15 días',   test: d => d > 15 },
]
// Los 5 buckets cubren todo el rango [0, ∞). Ningún lead queda fuera.
function exportAgingBucket(days: number): string {
  for (const b of EXPORT_AGING_BUCKETS) if (b.test(days)) return b.value
  return 'd_over15'  // fallback defensivo (no debería pasar)
}

function ExportModal({ leads, onClose, onDownload }: {
  leads: Lead[]
  onClose: () => void
  onDownload: (subset: Lead[]) => void
}) {
  const SIN_DATO = '— sin dato —'

  // Indexa los valores únicos por dimensión, con count
  type Bucket = { value: string; label: string; count: number }
  const buckets = useMemo(() => {
    const canalMap = new Map<string, number>()
    const ubicacionMap = new Map<string, number>()
    const presupuestoMap = new Map<string, number>()
    const intentosMap = new Map<string, number>()
    const agingMap = new Map<string, number>()

    for (const l of leads) {
      const canal = l.canal_adquisicion || SIN_DATO
      canalMap.set(canal, (canalMap.get(canal) || 0) + 1)

      const ubi = l.estado || phoneToState(l.telefono) || SIN_DATO
      ubicacionMap.set(ubi, (ubicacionMap.get(ubi) || 0) + 1)

      const pres = l.presupuesto
        ? PRESUPUESTO_LABELS[l.presupuesto as Presupuesto]
        : SIN_DATO
      presupuestoMap.set(pres, (presupuestoMap.get(pres) || 0) + 1)

      const intentos = String(l.veces_contactado || 0)
      intentosMap.set(intentos, (intentosMap.get(intentos) || 0) + 1)

      const ab = exportAgingBucket(daysInCurrentStage(l))
      agingMap.set(ab, (agingMap.get(ab) || 0) + 1)
    }
    const toList = (m: Map<string, number>): Bucket[] =>
      Array.from(m.entries())
        .map(([value, count]) => ({ value, label: value, count }))
        .sort((a, b) => b.count - a.count)
    // Aging en el orden definido en EXPORT_AGING_BUCKETS (1-3, 4-6, 7-10, 11-15, >15).
    // Siempre los 5 buckets, aunque alguno tenga 0 (es info útil "no hay leads en ese rango").
    const agingList: Bucket[] = EXPORT_AGING_BUCKETS
      .map(b => ({ value: b.value, label: b.label, count: agingMap.get(b.value) || 0 }))
    return {
      canales: toList(canalMap),
      ubicaciones: toList(ubicacionMap),
      presupuestos: toList(presupuestoMap),
      intentos: toList(intentosMap),
      aging: agingList,
    }
  }, [leads])

  // Estado de cada bucket: por default todos seleccionados
  const allValues = (bs: Bucket[]) => new Set(bs.map(b => b.value))
  const [selCanales, setSelCanales] = useState<Set<string>>(() => allValues(buckets.canales))
  const [selUbicaciones, setSelUbicaciones] = useState<Set<string>>(() => allValues(buckets.ubicaciones))
  const [selPresupuestos, setSelPresupuestos] = useState<Set<string>>(() => allValues(buckets.presupuestos))
  const [selIntentos, setSelIntentos] = useState<Set<string>>(() => allValues(buckets.intentos))
  const [selAging, setSelAging] = useState<Set<string>>(() => allValues(buckets.aging))

  // Subset filtrado en vivo
  const subset = useMemo(() => {
    return leads.filter(l => {
      const canal = l.canal_adquisicion || SIN_DATO
      if (!selCanales.has(canal)) return false
      const ubi = l.estado || phoneToState(l.telefono) || SIN_DATO
      if (!selUbicaciones.has(ubi)) return false
      const pres = l.presupuesto ? PRESUPUESTO_LABELS[l.presupuesto as Presupuesto] : SIN_DATO
      if (!selPresupuestos.has(pres)) return false
      const intentos = String(l.veces_contactado || 0)
      if (!selIntentos.has(intentos)) return false
      const aging = exportAgingBucket(daysInCurrentStage(l))
      if (!selAging.has(aging)) return false
      return true
    })
  }, [leads, selCanales, selUbicaciones, selPresupuestos, selIntentos, selAging])

  const toggleSet = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className={styles.modalHeader}>
          <div>
            <div className={styles.modalEmail}>⇣ Afinar export</div>
            <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 4 }}>
              {leads.length} leads visibles · desmarcá lo que no quieras incluir
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <ExportGroup title="Canal de adquisición" buckets={buckets.canales}
            selected={selCanales} onToggle={(v) => setSelCanales(s => toggleSet(s, v))}
            onAll={() => setSelCanales(allValues(buckets.canales))}
            onNone={() => setSelCanales(new Set())} />
          <ExportGroup title="Ubicación (estado)" buckets={buckets.ubicaciones}
            selected={selUbicaciones} onToggle={(v) => setSelUbicaciones(s => toggleSet(s, v))}
            onAll={() => setSelUbicaciones(allValues(buckets.ubicaciones))}
            onNone={() => setSelUbicaciones(new Set())} />
          <ExportGroup title="Presupuesto declarado" buckets={buckets.presupuestos}
            selected={selPresupuestos} onToggle={(v) => setSelPresupuestos(s => toggleSet(s, v))}
            onAll={() => setSelPresupuestos(allValues(buckets.presupuestos))}
            onNone={() => setSelPresupuestos(new Set())} />
          <ExportGroup title="Intentos de contacto" buckets={buckets.intentos}
            selected={selIntentos} onToggle={(v) => setSelIntentos(s => toggleSet(s, v))}
            onAll={() => setSelIntentos(allValues(buckets.intentos))}
            onNone={() => setSelIntentos(new Set())} />
          <ExportGroup title="Días sin contactar" buckets={buckets.aging}
            selected={selAging} onToggle={(v) => setSelAging(s => toggleSet(s, v))}
            onAll={() => setSelAging(allValues(buckets.aging))}
            onNone={() => setSelAging(new Set())} />
        </div>
        <div className={styles.modalFooter}>
          <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>
            Vas a descargar <strong style={{ color: 'var(--text)' }}>{subset.length}</strong> de {leads.length} leads
          </span>
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button className={styles.cancelBtn} onClick={onClose}>Cancelar</button>
            <button className={styles.saveBtn}
              disabled={subset.length === 0}
              onClick={() => onDownload(subset)}>
              ⇣ Descargar ({subset.length})
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ExportGroup({ title, buckets, selected, onToggle, onAll, onNone }: {
  title: string
  buckets: Array<{ value: string; label: string; count: number }>
  selected: Set<string>
  onToggle: (v: string) => void
  onAll: () => void
  onNone: () => void
}) {
  if (buckets.length === 0) return null
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: 11.5, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
          {title}
        </strong>
        <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
          <button onClick={onAll}
            style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
            todos
          </button>
          <button onClick={onNone}
            style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
            ninguno
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {buckets.map(b => {
          const on = selected.has(b.value)
          const empty = b.count === 0
          return (
            <label key={b.value}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: on ? 'rgba(124,106,247,0.18)' : 'var(--glass)',
                border: `1px solid ${on ? 'rgba(124,106,247,0.45)' : 'var(--border)'}`,
                color: empty ? 'var(--text3)' : on ? 'var(--text)' : 'var(--text2)',
                opacity: empty ? 0.55 : 1,
                borderRadius: 'var(--radius-pill)',
                padding: '5px 11px',
                fontSize: 12,
                cursor: empty ? 'default' : 'pointer',
                userSelect: 'none',
                transition: 'all 0.12s',
              }}>
              <input type="checkbox" checked={on} onChange={() => onToggle(b.value)}
                disabled={empty}
                style={{ accentColor: '#7c6af7', cursor: empty ? 'default' : 'pointer' }} />
              <span>{b.label}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                {b.count}
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
