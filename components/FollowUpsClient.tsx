'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
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

type FollowUp = {
  id: string
  lead_id: string | null
  titulo: string
  notas: string | null
  fecha: string
  tipo: string
  completado: boolean
  completado_at: string | null
  source: string
  gcal_event_id: string | null
  created_at: string
  updated_at: string
  lead: LeadJoined | null
}

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

export default function FollowUpsClient() {
  const [items, setItems] = useState<FollowUp[]>([])
  const [loading, setLoading] = useState(false)
  const [range, setRange] = useState<string>('todos')
  const [status, setStatus] = useState<string>('pendientes')
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<FollowUp | null>(null)
  const [importing, setImporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status, range, limit: '300' })
      const res = await fetch(`/api/follow-ups?${params}`, { cache: 'no-store' })
      const json = await res.json()
      setItems(json.follow_ups || [])
    } finally {
      setLoading(false)
    }
  }, [status, range])

  useEffect(() => { load() }, [load])

  const stats = useMemo(() => {
    const now = Date.now()
    const pendientes = items.filter(i => !i.completado)
    const overdue = pendientes.filter(i => new Date(i.fecha).getTime() < now)
    const hoy = pendientes.filter(i => {
      const d = new Date(i.fecha)
      return d.toDateString() === new Date().toDateString()
    })
    const completados = items.filter(i => i.completado).length
    return { pendientes: pendientes.length, overdue: overdue.length, hoy: hoy.length, completados }
  }, [items])

  async function toggleComplete(id: string, newVal: boolean) {
    await fetch(`/api/follow-ups/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ completado: newVal }),
    })
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

        <div className={styles.listContainer}>
          {items.length === 0 ? (
            <div className={styles.emptyState}>
              {loading ? 'Cargando…' : 'No hay follow ups con esos filtros.'}
            </div>
          ) : (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>
                Lista
                <span className={styles.sectionCount}>{items.length}</span>
              </h2>
              {items.map(fu => {
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
          )}
        </div>

        {showModal && (
          <FollowUpModal
            initial={editing}
            onClose={() => { setShowModal(false); setEditing(null) }}
            onSaved={() => { setShowModal(false); setEditing(null); load() }}
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
      const body = { titulo, notas: notas || null, fecha: fechaISO, tipo }
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
