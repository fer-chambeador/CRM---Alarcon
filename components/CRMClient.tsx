'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase, type Lead, type LeadActividad } from '@/lib/supabase'
import { format, formatDistanceToNow, startOfDay, startOfWeek, startOfMonth, subDays } from 'date-fns'
import { es } from 'date-fns/locale'
import clsx from 'clsx'
import styles from './CRMClient.module.css'
import { Sidebar } from './CommandCenter'
import {
  STATUS_LABELS, STATUS_ORDER, PIPELINE_CLOSING, PIPELINE_CLOSED,
  DEFAULT_MONTO, statusColor, fmtMoney,
} from '@/lib/status'
import { phoneToState, ALL_STATES } from '@/lib/lada'
import { PRESUPUESTO_VALUES, PRESUPUESTO_LABELS, PRESUPUESTO_COLORS, fmtPresupuesto } from '@/lib/budget'
import type { Presupuesto } from '@/lib/budget'

const CONTACTO_LABELS = ['—', '1er contacto', '2do contacto', '3er contacto', 'Descartado por intentos']
const MONTHLY_GOAL = 200000

function tipoLabel(t: string | null) {
  if (!t) return ''
  return { usuario_nuevo: '👤', empresa_creada: '🏢', suscripcion_nueva: '💳', manual: '✏️', pago_confirmado: '💰' }[t] ?? ''
}

function formatFecha(dateStr: string) {
  try { return format(new Date(dateStr), "d 'de' MMM, HH:mm", { locale: es }) }
  catch { return '—' }
}

// ─── Date filter ─────────────────────────────────────────────────────────────
type DateRange = 'todo' | 'hoy' | 'semana' | 'mes' | 'ultimos-30'
const DATE_LABELS: Record<DateRange, string> = {
  todo: 'Todo el tiempo',
  hoy: 'Hoy',
  semana: 'Esta semana',
  mes: 'Este mes',
  'ultimos-30': 'Últimos 30 días',
}
function dateRangeStart(range: DateRange): Date | null {
  const now = new Date()
  switch (range) {
    case 'todo': return null
    case 'hoy': return startOfDay(now)
    case 'semana': return startOfWeek(now, { weekStartsOn: 1 })
    case 'mes': return startOfMonth(now)
    case 'ultimos-30': return subDays(now, 30)
  }
}

// ─── Fuzzy search ────────────────────────────────────────────────────────────
function bigrams(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
  return out
}
function fuzzyScore(query: string, target: string | null | undefined): number {
  if (!target) return 0
  const q = query.toLowerCase().trim()
  const t = target.toLowerCase()
  if (!q) return 0
  if (t.includes(q)) return 100 + (q.length / t.length) * 20
  if (q.length < 3) return 0
  const qb = bigrams(q), tb = bigrams(t)
  if (!qb.length || !tb.length) return 0
  const tbSet = new Set(tb)
  let hits = 0
  for (const b of qb) if (tbSet.has(b)) hits++
  const overlap = hits / qb.length
  return overlap > 0.5 ? overlap * 50 : 0
}
function leadScore(query: string, lead: Lead): number {
  if (!query) return 1
  const fields: (string | null)[] = [
    lead.email, lead.nombre, lead.empresa, lead.telefono,
    lead.canal_adquisicion, lead.puesto,
  ]
  let best = 0
  for (const f of fields) best = Math.max(best, fuzzyScore(query, f))
  return best
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
    const res = await fetch('/api/leads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (data.error) { setError(data.error); setSaving(false); return }
    onAdd(data); onClose()
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
  })
  const [contactos, setContactos] = useState(lead.veces_contactado || 0)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const save = useCallback(async () => {
    setSaving(true)
    const res = await fetch(`/api/leads/${lead.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, estado: form.estado || null, presupuesto: form.presupuesto || null, vacante: form.vacante || null, veces_contactado: contactos }),
    })
    onSave(await res.json()); setSaving(false); onClose()
  }, [lead.id, form, contactos, onSave, onClose])

  const deleteLead = async () => {
    setDeleting(true)
    await fetch(`/api/leads/${lead.id}`, { method: 'DELETE' })
    onDelete(lead.id); onClose()
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
            <div className={styles.modalEmail}>{tipoLabel(lead.tipo_evento)} {lead.email}</div>
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
type SortKey = 'email' | 'empresa' | 'telefono' | 'ubicacion' | 'canal' | 'status' | 'monto' | 'presupuesto' | 'contacto' | 'fecha'
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

  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(
    initialLeadId ? initialLeads.find(l => l.id === initialLeadId) || null : null
  )
  const [showAddModal, setShowAddModal] = useState(initialNew)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<Lead['status'] | 'todos'>('todos')
  const [filterAttempts, setFilterAttempts] = useState<number | 'todos'>('todos')
  const [filterCanal, setFilterCanal] = useState<string>('todos')
  const [dateRange, setDateRange] = useState<DateRange>('todo')
  const [newLeadFlash, setNewLeadFlash] = useState<string | null>(null)
  const [liveCount, setLiveCount] = useState(0)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>({ key: 'fecha', dir: 'desc' })
  const [popover, setPopover] = useState<{ leadId: string; current: Lead['status']; x: number; y: number } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const channel = supabase.channel('leads-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newLead = payload.new as Lead
          setLeads(prev => [newLead, ...prev])
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
  const handleAdd = useCallback((lead: Lead) => { setLeads(prev => [lead, ...prev]) }, [])

  const updateStatus = useCallback(async (leadId: string, newStatus: Lead['status']) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: newStatus } : l))
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const updated = await res.json()
      if (updated && updated.id) setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))
    } catch {}
  }, [])

  const canales = useMemo(
    () => Array.from(new Set(leads.map(l => l.canal_adquisicion).filter((x): x is string => !!x))).sort(),
    [leads]
  )

  const dateScoped = useMemo(() => {
    const start = dateRangeStart(dateRange)
    if (!start) return leads
    return leads.filter(l => new Date(l.created_at) >= start)
  }, [leads, dateRange])

  const filtered = useMemo(() => {
    const q = search.trim()
    let rows = dateScoped.filter(lead => {
      const matchStatus = filterStatus === 'todos' || lead.status === filterStatus
      const matchCanal = filterCanal === 'todos' || lead.canal_adquisicion === filterCanal
      const matchAttempts = filterStatus !== 'contactado' || filterAttempts === 'todos'
        || (lead.veces_contactado || 0) === filterAttempts
      return matchStatus && matchCanal && matchAttempts
    })
    if (q) {
      rows = rows
        .map(l => ({ l, score: leadScore(q, l) }))
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(r => r.l)
    }
    return rows
  }, [dateScoped, search, filterStatus, filterAttempts, filterCanal])

  const sorted = useMemo(() => {
    if (!sort || search.trim()) return filtered
    const get = (l: Lead): string | number => {
      switch (sort.key) {
        case 'email': return (l.nombre || l.email).toLowerCase()
        case 'empresa': return (l.empresa || '').toLowerCase()
        case 'telefono': return l.telefono || ''
        case 'canal': return l.canal_adquisicion || ''
        case 'ubicacion': return l.estado || phoneToState(l.telefono) || ''
        case 'status': return STATUS_ORDER.indexOf(l.status)
        case 'monto': return l.monto ?? 0
        case 'presupuesto': {
          // Sort by tier rank: none < 100_to_1000 < 2000_to_5000 < 10000_plus, null last
          const rank: Record<string, number> = { none: 1, '100_to_1000': 2, '2000_to_5000': 3, '10000_plus': 4 }
          return l.presupuesto ? rank[l.presupuesto] || 0 : 0
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
  }, [filtered, sort, search])

  const onSort = (key: SortKey) => {
    setSort(s => s?.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'fecha' || key === 'contacto' || key === 'monto' ? 'desc' : 'asc' })
  }

  const stats = useMemo(() => {
    const sumMonto = (rows: Lead[]) => rows.reduce((acc, l) => acc + (l.monto ?? DEFAULT_MONTO), 0)
    const monthStart = startOfMonth(new Date())
    const closedThisMonth = leads.filter(l =>
      PIPELINE_CLOSED.includes(l.status) && new Date(l.created_at) >= monthStart
    )
    return {
      leads: dateScoped.length,
      pipelineTotal: sumMonto(dateScoped),
      pipelineCierre: sumMonto(dateScoped.filter(l => PIPELINE_CLOSING.includes(l.status))),
      pipelineCerradoMes: sumMonto(closedThisMonth),
      pipelineCerradoMesCount: closedThisMonth.length,
    }
  }, [dateScoped, leads])

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
            <div className={styles.kpiHeroLabel}>Pipeline total</div>
            <div className={styles.kpiHeroValue}>{fmtMoney(stats.pipelineTotal)}</div>
            <div className={styles.kpiHeroSub}>{stats.leads} leads · {DATE_LABELS[dateRange]}</div>
          </div>
          <div className={clsx(styles.kpiHeroCard, styles.kpiHeroIndigo)}>
            <div className={styles.kpiHeroLabel}>Pipeline en cierre</div>
            <div className={styles.kpiHeroValue}>{fmtMoney(stats.pipelineCierre)}</div>
            <div className={styles.kpiHeroSub}>Propuesta enviada + espera de aprobación</div>
          </div>
          <div className={clsx(styles.kpiHeroCard, styles.kpiHeroDark)}>
            <div className={styles.kpiHeroLabel}>Pipeline cerrado · este mes</div>
            <div className={styles.kpiHeroValue}>{fmtMoney(stats.pipelineCerradoMes)}</div>
            <div className={styles.kpiHeroSub}>
              {stats.pipelineCerradoMesCount} deals · meta {fmtMoney(MONTHLY_GOAL)}
              {' '}({Math.round(Math.min(1, stats.pipelineCerradoMes / MONTHLY_GOAL) * 100)}%)
            </div>
            <div className={styles.kpiHeroBar}>
              <div className={styles.kpiHeroBarFill}
                style={{ width: `${Math.min(100, (stats.pipelineCerradoMes / MONTHLY_GOAL) * 100)}%` }} />
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: '40px 0' }}>No hay leads que coincidan</td></tr>}
              {sorted.map(lead => {
                const isNew = newLeadFlash === lead.email
                const contactoLabel = CONTACTO_LABELS[Math.min(lead.veces_contactado || 0, CONTACTO_LABELS.length - 1)]
                const isDescartadoPorIntentos = (lead.veces_contactado || 0) >= CONTACTO_LABELS.length - 1
                return (
                  <tr key={lead.id} className={clsx(styles.row, isNew && styles.rowFlash)}
                      onClick={() => setSelectedLead(lead)}>
                    <td>
                      <div className={styles.emailCell}>
                        <span className={styles.tipoIcon}>{tipoLabel(lead.tipo_evento)}</span>
                        <div>
                          {lead.nombre && <div className={styles.leadName}>{lead.nombre}</div>}
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
                      <button className={styles.statusInlineBtn}
                        title="Click para cambiar status"
                        onClick={(e) => {
                          const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                          setPopover({ leadId: lead.id, current: lead.status, x: r.left + window.scrollX, y: r.bottom + window.scrollY + 4 })
                        }}>
                        <span className={styles.statusTag} style={{ '--sc': statusColor(lead.status) } as React.CSSProperties}>{STATUS_LABELS[lead.status]}</span>
                        <span className={styles.statusInlineCaret}>▾</span>
                      </button>
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
                      {lead.veces_contactado > 0
                        ? <span className={styles.contactCount} style={{ color: isDescartadoPorIntentos ? 'var(--red)' : 'var(--yellow)' }}>{contactoLabel}</span>
                        : <span className={styles.empty}>—</span>}
                    </td>
                    <td className={styles.timeCell}>{formatFecha(lead.created_at)}</td>
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
      {popover && (
        <StatusPopover current={popover.current} anchor={{ x: popover.x, y: popover.y }}
          onPick={(s) => { updateStatus(popover.leadId, s); setPopover(null) }}
          onClose={() => setPopover(null)} />
      )}
    </div>
  )
}
