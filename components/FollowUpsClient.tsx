'use client'

import { useEffect, useState, useCallback } from 'react'
import clsx from 'clsx'
import { Sidebar } from './CommandCenter'
import styles from './FollowUpsClient.module.css'

type LeadJoined = {
  id: string
  nombre: string | null
  email: string | null
  empresa: string | null
  telefono: string | null
  status: string
}

type Prioridad = 'urgente' | 'normal' | 'baja'

type FollowUp = {
  id: string
  lead_id: string | null
  titulo: string
  notas: string | null
  fecha: string
  tipo: string
  prioridad: Prioridad
  completado: boolean
  completado_at: string | null
  source: string
  gcal_event_id: string | null
  created_at: string
  updated_at: string
  lead: LeadJoined | null
}

// 3 secciones visuales que pidió Fer.
const SECTIONS: Array<{ key: Prioridad; label: string; emoji: string; description: string; color: string }> = [
  { key: 'urgente', label: 'Urgentes',        emoji: '🔥', description: 'Liga de pago, llamadas críticas, presentación >3 días sin respuesta', color: '#e85454' },
  { key: 'normal',  label: 'Normales',        emoji: '📋', description: 'Propuestas en curso, llamadas reagendadas, seguimientos rutinarios',  color: '#7c5cff' },
  { key: 'baja',    label: 'Poco potencial',  emoji: '🌑', description: 'Buzones repetidos, leads sin respuesta tras varios intentos',          color: '#5a6072' },
]

const TIPO_LABEL: Record<string, string> = {
  general: 'General',
  llamada: 'Llamada',
  mensaje: 'Mensaje',
  pago: 'Pago',
  presentacion: 'Presentación',
}

function fmtFechaCorta(s: string): string {
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  const now = new Date()
  const same = d.toDateString() === now.toDateString()
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow = d.toDateString() === tomorrow.toDateString()
  const time = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
  if (same) return `Hoy ${time}`
  if (isTomorrow) return `Mañana ${time}`
  return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function fechaUrgencia(s: string, completado: boolean): 'overdue' | 'urgent' | 'normal' {
  if (completado) return 'normal'
  const d = new Date(s).getTime()
  const now = Date.now()
  if (d < now) return 'overdue'
  if (d - now < 48 * 3600 * 1000) return 'urgent'
  return 'normal'
}

const RANGES = [
  { key: 'todos', label: 'Todos' },
  { key: 'atrasados', label: 'Atrasados' },
  { key: 'hoy', label: 'Hoy' },
  { key: 'manana', label: 'Mañana' },
  { key: 'semana', label: 'Esta semana' },
] as const

const STATUS = [
  { key: 'pendientes', label: 'Pendientes' },
  { key: 'completados', label: 'Completados' },
  { key: 'todos', label: 'Todos' },
] as const

// Filtro por tipo de acción (etapa). Orden = importancia descendente.
const TIPO_FILTERS = [
  { key: 'todos',        label: 'Todos',            emoji: '📌' },
  { key: 'pago',         label: 'Confirmar pago',   emoji: '💰' },
  { key: 'presentacion', label: 'Confirmar revisión', emoji: '📋' },
  { key: 'llamada',      label: 'Llamar',           emoji: '📞' },
  { key: 'mensaje',      label: 'Mensaje',          emoji: '💬' },
  { key: 'general',      label: 'General',          emoji: '✏️' },
] as const

// Prioridad por tipo dentro de una misma sección (pago > presentacion > etc).
const TIPO_RANK: Record<string, number> = {
  pago: 1,
  presentacion: 2,
  llamada: 3,
  mensaje: 4,
  general: 5,
}

export default function FollowUpsClient() {
  const [items, setItems] = useState<FollowUp[]>([])
  const [loading, setLoading] = useState(false)
  const [range, setRange] = useState<string>('todos')
  const [status, setStatus] = useState<string>('pendientes')
  const [tipoFilter, setTipoFilter] = useState<string>('todos')
  const [nextStepModal, setNextStepModal] = useState<FollowUp | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<FollowUp | null>(null)
  const [importing, setImporting] = useState(false)
  // BUG FIX (audit 17-jun-2026): stats venían del array local `items`, pero
  // ese array ya está filtrado por el status seleccionado en el sidebar (por
  // defecto 'pendientes'). Por eso "Completados" siempre mostraba 0 y "Hoy"
  // mostraba 0 cuando el filtro temporal del usuario no incluía hoy. Ahora
  // los counts vienen de un endpoint dedicado /api/follow-ups/stats que
  // cuenta en BD sin filtros de UI.
  const [stats, setStats] = useState({ pendientes: 0, overdue: 0, hoy: 0, completados: 0 })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status, range, limit: '300' })
      const [listRes, statsRes] = await Promise.all([
        fetch(`/api/follow-ups?${params}`, { cache: 'no-store' }),
        fetch('/api/follow-ups/stats', { cache: 'no-store' }),
      ])
      const listJson = await listRes.json()
      setItems(listJson.follow_ups || [])
      if (statsRes.ok) {
        const s = await statsRes.json()
        setStats({
          pendientes: s.pendientes || 0,
          overdue: s.atrasados || 0,
          hoy: s.hoy || 0,
          completados: s.completados || 0,
        })
      }
    } finally {
      setLoading(false)
    }
  }, [status, range])

  useEffect(() => { load() }, [load])

  async function toggleComplete(id: string, newVal: boolean) {
    await fetch(`/api/follow-ups/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ completado: newVal }),
    })
    // Si se marcó como completado, abrimos modal para que Fer defina siguiente paso
    if (newVal) {
      const fu = items.find(i => i.id === id)
      if (fu) setNextStepModal({ ...fu, completado: true })
    }
    load()
  }

  async function deleteItem(id: string) {
    if (!confirm('¿Eliminar este follow up?')) return
    await fetch(`/api/follow-ups/${id}`, { method: 'DELETE' })
    load()
  }

  async function importFromGcal() {
    if (!confirm('Importar TODOS los "Follow Up - X" de tu Google Calendar al CRM y BORRARLOS del calendar.\n\nEsto liberará tu agenda para que Vambe pueda agendar leads en cualquier hueco.\n\n¿Continuar?')) return
    setImporting(true)
    try {
      const res = await fetch('/api/follow-ups/import-from-gcal?delete=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days_ahead: 120 }),
      })
      const json = await res.json()
      if (!res.ok) {
        alert(`Error: ${json.error || res.status}`)
        return
      }
      alert(`✅ Importados: ${json.imported}\n🗑 Borrados del Calendar: ${json.deleted}\n⏭ Ya existían: ${json.skipped}\n${json.errors_count > 0 ? `⚠️ Errores: ${json.errors_count}` : ''}`)
      load()
    } catch (e) {
      alert(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="follow-ups" />
      </aside>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <h1>📌 Follow Ups</h1>
          <span className={styles.topBarSpacer} />
          <button className={styles.secondaryBtn} onClick={importFromGcal} disabled={importing}>
            {importing ? 'Importando…' : '📥 Importar de Calendar'}
          </button>
          <button className={styles.refreshBtn} onClick={load} disabled={loading}>
            {loading ? 'Cargando…' : '↻ Refresh'}
          </button>
          <button className={styles.primaryBtn} onClick={() => { setEditing(null); setShowModal(true) }}>
            + Nuevo follow up
          </button>
        </div>

        <div className={styles.mainHeader}>
          Cada follow up vive en el CRM (no en tu Google Calendar). Así Vambe puede agendar libremente.
        </div>

        <div className={styles.kpiRow}>
          <div className={styles.kpiCard}><div className={styles.kpiLabel}>Pendientes</div><div className={styles.kpiValue}>{stats.pendientes}</div></div>
          <div className={styles.kpiCard}><div className={styles.kpiLabel}>Atrasados</div><div className={styles.kpiValue} style={{ color: stats.overdue > 0 ? '#e85454' : undefined }}>{stats.overdue}</div></div>
          <div className={styles.kpiCard}><div className={styles.kpiLabel}>Hoy</div><div className={styles.kpiValue}>{stats.hoy}</div></div>
          <div className={styles.kpiCard}><div className={styles.kpiLabel}>Completados</div><div className={styles.kpiValue}>{stats.completados}</div></div>
        </div>

        <div className={styles.filterBar}>
          {STATUS.map(s => (
            <button key={s.key} className={clsx(styles.filterChip, status === s.key && styles.filterChipActive)} onClick={() => setStatus(s.key)}>
              {s.label}
            </button>
          ))}
          <span style={{ width: 14 }} />
          {RANGES.map(r => (
            <button key={r.key} className={clsx(styles.filterChip, range === r.key && styles.filterChipActive)} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>

        {/* Filtro por tipo de acción (NUEVO 7-jun-2026) */}
        <div className={styles.filterBar} style={{ marginTop: 8 }}>
          {TIPO_FILTERS.map(t => {
            const count = t.key === 'todos'
              ? items.length
              : items.filter(i => (i.tipo || 'general') === t.key).length
            return (
              <button
                key={t.key}
                className={clsx(styles.filterChip, tipoFilter === t.key && styles.filterChipActive)}
                onClick={() => setTipoFilter(t.key)}
                title={`${t.label} (${count})`}
              >
                <span style={{ marginRight: 6 }}>{t.emoji}</span>{t.label}
                {count > 0 && <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 11 }}>{count}</span>}
              </button>
            )
          })}
        </div>

        <div className={styles.listContainer}>
          {items.length === 0 ? (
            <div className={styles.emptyState}>
              {loading ? 'Cargando…' : 'No hay follow ups con esos filtros.'}
            </div>
          ) : (
            SECTIONS.map(section => {
              const sectionItems = items
                .filter(i => (i.prioridad || 'normal') === section.key)
                .filter(i => tipoFilter === 'todos' || (i.tipo || 'general') === tipoFilter)
                .sort((a, b) => {
                  // Orden: tipo (pago > presentacion > llamada > mensaje > general),
                  // luego por fecha ascendente.
                  const ra = TIPO_RANK[a.tipo || 'general'] ?? 99
                  const rb = TIPO_RANK[b.tipo || 'general'] ?? 99
                  if (ra !== rb) return ra - rb
                  return new Date(a.fecha).getTime() - new Date(b.fecha).getTime()
                })
              if (sectionItems.length === 0) return null
              return (
                <div key={section.key} className={styles.section} style={{ borderLeft: `3px solid ${section.color}`, paddingLeft: 14, marginBottom: 28 }}>
                  <h2 className={styles.sectionTitle} style={{ color: section.color }}>
                    <span style={{ marginRight: 8 }}>{section.emoji}</span>
                    {section.label}
                    <span className={styles.sectionCount} style={{ background: section.color, color: 'white' }}>{sectionItems.length}</span>
                  </h2>
                  <div style={{ fontSize: 12, opacity: 0.6, marginTop: -8, marginBottom: 10 }}>{section.description}</div>
                  {sectionItems.map(fu => {
                    const urg = fechaUrgencia(fu.fecha, fu.completado)
                    return (
                      <div key={fu.id} className={styles.fuRow}>
                        <input type="checkbox" className={styles.fuCheck} checked={fu.completado} onChange={e => toggleComplete(fu.id, e.target.checked)} />
                        <div className={styles.fuBody} onClick={() => { setEditing(fu); setShowModal(true) }}>
                          <div className={styles.fuHead}>
                            <span className={clsx(styles.fuTitle, fu.completado && styles.completed)}>{fu.titulo}</span>
                            <span className={clsx(styles.fuDate, urg === 'urgent' && styles.fuDateUrgent, urg === 'overdue' && styles.fuDateOverdue)}>
                              {fmtFechaCorta(fu.fecha)}
                            </span>
                            <span className={styles.fuTipo}>{TIPO_LABEL[fu.tipo] || fu.tipo}</span>
                          </div>
                          {fu.lead && (
                            <div className={styles.fuLead}>
                              → <a href={`/leads/${fu.lead.id}`}>{fu.lead.nombre || fu.lead.empresa || fu.lead.email}</a>
                              {fu.lead.telefono ? ` · ${fu.lead.telefono}` : ''}
                            </div>
                          )}
                          {fu.notas && <div className={styles.fuNotas}>{fu.notas.length > 200 ? fu.notas.slice(0, 200) + '…' : fu.notas}</div>}
                        </div>
                        <div className={styles.fuActions}>
                          <button className={styles.iconBtn} onClick={() => { setEditing(fu); setShowModal(true) }} title="Editar">✎</button>
                          <button className={styles.iconBtn} onClick={() => deleteItem(fu.id)} title="Eliminar">🗑</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        {showModal && (
          <FollowUpModal
            initial={editing}
            onClose={() => { setShowModal(false); setEditing(null) }}
            onSaved={() => { setShowModal(false); setEditing(null); load() }}
          />
        )}

        {nextStepModal && (
          <NextStepModal
            completedFollowUp={nextStepModal}
            onClose={() => setNextStepModal(null)}
            onDone={() => { setNextStepModal(null); load() }}
          />
        )}
      </main>
    </div>
  )
}

function FollowUpModal({ initial, onClose, onSaved }: { initial: FollowUp | null; onClose: () => void; onSaved: () => void }) {
  const [titulo, setTitulo] = useState(initial?.titulo || '')
  const [notas, setNotas] = useState(initial?.notas || '')
  const [tipo, setTipo] = useState(initial?.tipo || 'general')
  const [prioridad, setPrioridad] = useState<Prioridad>(initial?.prioridad || 'normal')
  const [fecha, setFecha] = useState(() => {
    if (initial?.fecha) {
      const d = new Date(initial.fecha)
      const off = d.getTimezoneOffset()
      const local = new Date(d.getTime() - off * 60_000)
      return local.toISOString().slice(0, 16)
    }
    const def = new Date(Date.now() + 24 * 3600_000)
    def.setMinutes(0); def.setSeconds(0); def.setMilliseconds(0)
    const off = def.getTimezoneOffset()
    return new Date(def.getTime() - off * 60_000).toISOString().slice(0, 16)
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!titulo.trim() || !fecha) return
    setSaving(true)
    try {
      const fechaISO = new Date(fecha).toISOString()
      const body = { titulo, notas: notas || null, fecha: fechaISO, tipo, prioridad }
      const url = initial ? `/api/follow-ups/${initial.id}` : '/api/follow-ups'
      const method = initial ? 'PATCH' : 'POST'
      const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        alert(`Error: ${j.error || res.status}`); return
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>{initial ? 'Editar follow up' : 'Nuevo follow up'}</h2>
        <div className={styles.modalField}>
          <label>Título</label>
          <input value={titulo} onChange={e => setTitulo(e.target.value)} placeholder="Llamar a Henry para confirmar..." autoFocus />
        </div>
        <div className={styles.modalField}>
          <label>Fecha y hora</label>
          <input type="datetime-local" value={fecha} onChange={e => setFecha(e.target.value)} />
        </div>
        <div className={styles.modalField}>
          <label>Tipo</label>
          <select value={tipo} onChange={e => setTipo(e.target.value)}>
            <option value="general">General</option>
            <option value="llamada">Llamada</option>
            <option value="mensaje">Mensaje</option>
            <option value="pago">Pago</option>
            <option value="presentacion">Presentación</option>
          </select>
        </div>
        <div className={styles.modalField}>
          <label>Prioridad</label>
          <select value={prioridad} onChange={e => setPrioridad(e.target.value as Prioridad)}>
            <option value="urgente">🔥 Urgente</option>
            <option value="normal">📋 Normal</option>
            <option value="baja">🌑 Poco potencial</option>
          </select>
        </div>
        <div className={styles.modalField}>
          <label>Notas</label>
          <textarea value={notas} onChange={e => setNotas(e.target.value)} placeholder="Contexto del follow up..." />
        </div>
        <div className={styles.modalFooter}>
          <button className={styles.secondaryBtn} onClick={onClose}>Cancelar</button>
          <button className={styles.primaryBtn} onClick={save} disabled={saving || !titulo.trim() || !fecha}>
            {saving ? 'Guardando…' : initial ? 'Guardar' : 'Crear'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Modal post-complete que aparece al marcar un follow up como hecho.
 * Pregunta: ¿siguiente paso? convertir? descartar? sin acción?
 */
function NextStepModal({ completedFollowUp, onClose, onDone }: {
  completedFollowUp: FollowUp
  onClose: () => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<'menu' | 'next' | 'convert' | 'discard'>('menu')
  const [nextDate, setNextDate] = useState(() => {
    const def = new Date(Date.now() + 2 * 24 * 3600_000)
    def.setMinutes(0); def.setSeconds(0); def.setMilliseconds(0)
    const off = def.getTimezoneOffset()
    return new Date(def.getTime() - off * 60_000).toISOString().slice(0, 16)
  })
  const [nextTipo, setNextTipo] = useState<string>('general')
  const [nextPrioridad, setNextPrioridad] = useState<Prioridad>('normal')
  const [nextNotas, setNextNotas] = useState('')
  const [discardReason, setDiscardReason] = useState('')
  const [saving, setSaving] = useState(false)

  const leadId = completedFollowUp.lead_id
  const leadName = completedFollowUp.lead?.nombre || completedFollowUp.lead?.empresa || completedFollowUp.lead?.email || completedFollowUp.titulo

  async function createNextFollowUp() {
    if (!nextDate) return
    setSaving(true)
    try {
      const fechaISO = new Date(nextDate).toISOString()
      const body = {
        lead_id: leadId,
        titulo: `Continuación de "${completedFollowUp.titulo.slice(0, 80)}"`,
        notas: nextNotas || `Generado tras completar el follow up anterior (${completedFollowUp.id.slice(0, 8)}).`,
        fecha: fechaISO,
        tipo: nextTipo,
        prioridad: nextPrioridad,
        source: 'manual',
      }
      const r = await fetch('/api/follow-ups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) { alert('Error creando next step'); return }
      onDone()
    } finally { setSaving(false) }
  }

  async function markConverted() {
    if (!leadId) { alert('Este follow up no tiene lead linkado'); return }
    setSaving(true)
    try {
      await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'convertido' }),
      })
      onDone()
    } finally { setSaving(false) }
  }

  async function markDiscarded() {
    if (!leadId) { alert('Este follow up no tiene lead linkado'); return }
    setSaving(true)
    try {
      await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'descartado', razon_descarte: discardReason || 'Sin razón especificada' }),
      })
      onDone()
    } finally { setSaving(false) }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <h2 className={styles.modalTitle}>
          ✅ Follow up marcado como hecho
        </h2>
        <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 16 }}>
          <strong>{leadName}</strong> — ¿qué sigue?
        </div>

        {mode === 'menu' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className={styles.secondaryBtn}
              style={{ padding: '14px 16px', textAlign: 'left', justifyContent: 'flex-start' }}
              onClick={() => setMode('next')}
            >
              <strong>📅 Crear siguiente paso</strong>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>Define cuándo y qué hacer después</div>
            </button>
            <button
              className={styles.secondaryBtn}
              style={{ padding: '14px 16px', textAlign: 'left', justifyContent: 'flex-start', borderColor: '#22d68a' }}
              onClick={() => setMode('convert')}
            >
              <strong style={{ color: '#22d68a' }}>✅ Lead convertido (pagó)</strong>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>Cierra el lead como ganado</div>
            </button>
            <button
              className={styles.secondaryBtn}
              style={{ padding: '14px 16px', textAlign: 'left', justifyContent: 'flex-start', borderColor: '#e85454' }}
              onClick={() => setMode('discard')}
            >
              <strong style={{ color: '#e85454' }}>🚫 Lead descartado</strong>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>No avanza, especifica razón</div>
            </button>
            <button
              className={styles.secondaryBtn}
              style={{ padding: '10px 16px', textAlign: 'left', justifyContent: 'flex-start', opacity: 0.7 }}
              onClick={onClose}
            >
              Sin acción · cerrar
            </button>
          </div>
        )}

        {mode === 'next' && (
          <>
            <div className={styles.modalField}>
              <label>Cuándo</label>
              <input type="datetime-local" value={nextDate} onChange={e => setNextDate(e.target.value)} autoFocus />
            </div>
            <div className={styles.modalField}>
              <label>Acción</label>
              <select value={nextTipo} onChange={e => setNextTipo(e.target.value)}>
                <option value="llamada">📞 Llamar</option>
                <option value="mensaje">💬 Mensaje WhatsApp</option>
                <option value="presentacion">📋 Confirmar revisión</option>
                <option value="pago">💰 Confirmar pago</option>
                <option value="general">📌 General</option>
              </select>
            </div>
            <div className={styles.modalField}>
              <label>Prioridad</label>
              <select value={nextPrioridad} onChange={e => setNextPrioridad(e.target.value as Prioridad)}>
                <option value="urgente">🔥 Urgente</option>
                <option value="normal">📋 Normal</option>
                <option value="baja">🌑 Poco potencial</option>
              </select>
            </div>
            <div className={styles.modalField}>
              <label>Notas</label>
              <textarea value={nextNotas} onChange={e => setNextNotas(e.target.value)} placeholder="Qué se acordó / qué hay que hacer" />
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.secondaryBtn} onClick={() => setMode('menu')}>← Volver</button>
              <button className={styles.primaryBtn} onClick={createNextFollowUp} disabled={saving || !nextDate}>
                {saving ? 'Creando…' : 'Crear next step'}
              </button>
            </div>
          </>
        )}

        {mode === 'convert' && (
          <>
            <div style={{ background: 'rgba(34,214,138,0.08)', border: '1px solid #22d68a40', borderRadius: 8, padding: '12px 14px', fontSize: 13, lineHeight: 1.5 }}>
              El lead pasará a status <strong>Convertido</strong> y se borrará cualquier follow up pendiente de Google Calendar.
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.secondaryBtn} onClick={() => setMode('menu')}>← Volver</button>
              <button className={styles.primaryBtn} onClick={markConverted} disabled={saving} style={{ background: '#22d68a' }}>
                {saving ? 'Cerrando…' : '✅ Sí, convertido'}
              </button>
            </div>
          </>
        )}

        {mode === 'discard' && (
          <>
            <div className={styles.modalField}>
              <label>Razón de descarte</label>
              <textarea
                value={discardReason}
                onChange={e => setDiscardReason(e.target.value)}
                placeholder="No interesado, no contestó, demasiado caro, etc"
                autoFocus
              />
            </div>
            <div className={styles.modalFooter}>
              <button className={styles.secondaryBtn} onClick={() => setMode('menu')}>← Volver</button>
              <button className={styles.primaryBtn} onClick={markDiscarded} disabled={saving} style={{ background: '#e85454' }}>
                {saving ? 'Descartando…' : '🚫 Sí, descartar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
