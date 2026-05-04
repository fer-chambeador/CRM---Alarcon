'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase, type Lead } from '@/lib/supabase'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import clsx from 'clsx'
import styles from './CRMClient.module.css'

const STATUS_LABELS: Record<Lead['status'], string> = {
  nuevo: 'Nuevo', contactado: 'Contactado', en_negociacion: 'En Negociación',
  convertido: 'Convertido', descartado: 'Descartado',
}
const STATUS_ORDER: Lead['status'][] = ['nuevo','contactado','en_negociacion','convertido','descartado']

const CONTACTO_LABELS = ['—', '1er contacto', '2do contacto', '3er contacto', 'Descartado por intentos']

function statusColor(s: Lead['status']) {
  const map: Record<Lead['status'], string> = {
    nuevo: '#4ea8f5', contactado: '#f5c842', en_negociacion: '#f5914e',
    convertido: '#22d68a', descartado: '#606078',
  }
  return map[s]
}

function tipoLabel(t: string | null) {
  if (!t) return ''
  return { usuario_nuevo: '👤', empresa_creada: '🏢', suscripcion_nueva: '💳', manual: '✏️', pago_confirmado: '💰' }[t] ?? ''
}

function planBadge(plan: string | null) {
  if (!plan) return null
  const colors: Record<string, string> = {
    'Plan Starter': '#4ea8f5', 'Plan Pro': '#a594ff',
    'Plan Premium': '#f5c842', 'Plan Enterprise': '#22d68a',
  }
  return { plan, color: colors[plan] || '#9090a8' }
}

function formatFecha(dateStr: string) {
  try {
    return format(new Date(dateStr), "d 'de' MMM, HH:mm", { locale: es })
  } catch { return '—' }
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

// ─── Add Lead Modal ──────────────────────────────────────────────────────────
function AddLeadModal({ onClose, onAdd }: { onClose: () => void; onAdd: (lead: Lead) => void }) {
  const [form, setForm] = useState({ email: '', nombre: '', empresa: '', telefono: '', puesto: '', canal_adquisicion: '', notas: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (!form.email) { setError('El email es requerido'); return }
    setSaving(true)
    const res = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    const data = await res.json()
    if (data.error) { setError(data.error); setSaving(false); return }
    onAdd(data); onClose()
  }

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
            <label><span>Email *</span><input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="email@empresa.com" /></label>
            <label><span>Nombre</span><input value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} placeholder="Nombre completo" /></label>
            <label><span>Empresa</span><input value={form.empresa} onChange={e => setForm(f => ({ ...f, empresa: e.target.value }))} placeholder="Nombre de empresa" /></label>
            <label><span>Teléfono</span><input value={form.telefono} onChange={e => setForm(f => ({ ...f, telefono: e.target.value }))} placeholder="55 XXXX XXXX" /></label>
            <label><span>Puesto / Rol</span><input value={form.puesto} onChange={e => setForm(f => ({ ...f, puesto: e.target.value }))} placeholder="Reclutador, Dueño, etc." /></label>
            <label><span>Canal</span><input value={form.canal_adquisicion} onChange={e => setForm(f => ({ ...f, canal_adquisicion: e.target.value }))} placeholder="Facebook, LinkedIn..." /></label>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Notas</span>
            <textarea value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))} placeholder="Notas sobre este lead..." rows={3} style={{ resize: 'vertical' }} />
          </label>
        </div>
        <div className={styles.modalFooter}>
          <div />
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
    status: lead.status, notas: lead.notas || '', plan: lead.plan || '',
  })
  const [contactos, setContactos] = useState(lead.veces_contactado || 0)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const save = async () => {
    setSaving(true)
    const res = await fetch(`/api/leads/${lead.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, veces_contactado: contactos }),
    })
    onSave(await res.json()); setSaving(false); onClose()
  }

  const deleteLead = async () => {
    setDeleting(true)
    await fetch(`/api/leads/${lead.id}`, { method: 'DELETE' })
    onDelete(lead.id); onClose()
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div>
            <div className={styles.modalEmail}>{tipoLabel(lead.tipo_evento)} {lead.email}</div>
            <div className={styles.modalMeta}>
              {formatFecha(lead.created_at)}
              {lead.plan && <span className={styles.contactBadge}>💳 {lead.plan}</span>}
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
            <label><span>Canal</span><input value={form.canal_adquisicion} onChange={e => setForm(f => ({ ...f, canal_adquisicion: e.target.value }))} placeholder="Facebook, Metro..." /></label>
            <label><span>Plan</span>
              <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}>
                <option value="">Sin plan</option>
                <option value="Plan Starter">Plan Starter</option>
                <option value="Plan Pro">Plan Pro</option>
                <option value="Plan Premium">Plan Premium</option>
                <option value="Plan Enterprise">Plan Enterprise</option>
              </select>
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
        </div>
        <div className={styles.modalFooter}>
          <div style={{ display: 'flex', gap: 8 }}>
            {!confirmDelete
              ? <button className={styles.deleteBtn} onClick={() => setConfirmDelete(true)}>🗑 Eliminar</button>
              : <button className={styles.deleteConfirmBtn} onClick={deleteLead} disabled={deleting}>{deleting ? 'Eliminando...' : '⚠️ Confirmar'}</button>
            }
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

// ─── Main CRM ────────────────────────────────────────────────────────────────
export default function CRMClient({ initialLeads }: { initialLeads: Lead[] }) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<Lead['status'] | 'todos'>('todos')
  const [newLeadFlash, setNewLeadFlash] = useState<string | null>(null)
  const [liveCount, setLiveCount] = useState(0)

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
          setLeads(prev => prev.filter(l => l.id !== (payload.old as Lead).id))
        }
      }).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [selectedLead])

  const handleSave = useCallback((updated: Lead) => {
    setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))
  }, [])
  const handleDelete = useCallback((id: string) => { setLeads(prev => prev.filter(l => l.id !== id)) }, [])
  const handleAdd = useCallback((lead: Lead) => { setLeads(prev => [lead, ...prev]) }, [])

  const filtered = leads.filter(lead => {
    const matchSearch = !search || [lead.email, lead.nombre, lead.empresa, lead.telefono, lead.canal_adquisicion, lead.puesto]
      .some(v => v?.toLowerCase().includes(search.toLowerCase()))
    const matchStatus = filterStatus === 'todos' || lead.status === filterStatus
    return matchSearch && matchStatus
  })

  const stats = {
    total: leads.length,
    nuevos: leads.filter(l => l.status === 'nuevo').length,
    convertidos: leads.filter(l => l.status === 'convertido').length,
    conEmpresa: leads.filter(l => l.empresa).length,
  }

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        {liveCount > 0 && <div className={styles.livePill}><span className={styles.liveDot} />{liveCount} nuevo{liveCount > 1 ? 's' : ''} en vivo</div>}
        <div className={styles.stats}>
          <div className={styles.statCard}><div className={styles.statNum}>{stats.total}</div><div className={styles.statLabel}>Total leads</div></div>
          <div className={styles.statCard}><div className={styles.statNum} style={{ color: 'var(--status-nuevo)' }}>{stats.nuevos}</div><div className={styles.statLabel}>Sin contactar</div></div>
          <div className={styles.statCard}><div className={styles.statNum} style={{ color: 'var(--status-convertido)' }}>{stats.convertidos}</div><div className={styles.statLabel}>Convertidos</div></div>
          <div className={styles.statCard}><div className={styles.statNum} style={{ color: 'var(--accent)' }}>{stats.conEmpresa}</div><div className={styles.statLabel}>Con empresa</div></div>
        </div>
        <div style={{ padding: '0 16px 12px' }}>
          <button className={styles.addLeadBtn} onClick={() => setShowAddModal(true)}>+ Agregar lead</button>
        </div>
        <div className={styles.filterSection}>
          <div className={styles.filterLabel}>Filtrar por status</div>
          {(['todos', ...STATUS_ORDER] as const).map(s => (
            <button key={s} className={clsx(styles.filterBtn, filterStatus === s && styles.filterBtnActive)}
              onClick={() => setFilterStatus(s)}
              style={s !== 'todos' ? { '--sc': statusColor(s as Lead['status']) } as React.CSSProperties : {}}>
              {s === 'todos' ? 'Todos' : STATUS_LABELS[s as Lead['status']]}
              <span className={styles.filterCount}>{s === 'todos' ? leads.length : leads.filter(l => l.status === s).length}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>🔍</span>
            <input className={styles.searchInput} type="text" placeholder="Buscar por email, empresa, nombre..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className={styles.topBarRight}>
            <div className={styles.liveIndicator}><span className={styles.liveDotGreen} />En vivo desde Slack</div>
          </div>
        </div>

        {newLeadFlash && <div className={styles.flashBanner}>🆕 Nuevo lead: <strong>{newLeadFlash}</strong></div>}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Lead</th><th>Empresa</th><th>Teléfono</th><th>Canal</th><th>Plan</th><th>Status</th><th>Contacto</th><th>Fecha</th><th></th></tr>
            </thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: '40px 0' }}>No hay leads que coincidan</td></tr>}
              {filtered.map(lead => {
                const pb = planBadge(lead.plan)
                const isNew = newLeadFlash === lead.email
                const contactoLabel = CONTACTO_LABELS[Math.min(lead.veces_contactado || 0, CONTACTO_LABELS.length - 1)]
                const isDescartadoPorIntentos = (lead.veces_contactado || 0) >= CONTACTO_LABELS.length - 1
                return (
                  <tr key={lead.id} className={clsx(styles.row, isNew && styles.rowFlash)} onClick={() => setSelectedLead(lead)}>
                    <td>
                      <div className={styles.emailCell}>
                        <span className={styles.tipoIcon}>{tipoLabel(lead.tipo_evento)}</span>
                        <div>
                          {lead.nombre && <div className={styles.leadName}>{lead.nombre}</div>}
                          <div className={styles.leadEmail}>{lead.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className={styles.empresaCell}>{lead.empresa || <span className={styles.empty}>—</span>}</td>
                    <td onClick={e => e.stopPropagation()}>
                      {lead.telefono
                        ? <span className={styles.telefonoCell} onClick={() => navigator.clipboard.writeText(lead.telefono!)} title="Click para copiar">
                            {lead.telefono} <span className={styles.copyIcon}>📋</span>
                          </span>
                        : <span className={styles.empty}>—</span>}
                    </td>
                    <td>{lead.canal_adquisicion ? <span className={styles.canalTag}>{lead.canal_adquisicion}</span> : <span className={styles.empty}>—</span>}</td>
                    <td>{pb ? <span className={styles.planTag} style={{ '--pc': pb.color } as React.CSSProperties}>{pb.plan}</span> : <span className={styles.empty}>—</span>}</td>
                    <td><span className={styles.statusTag} style={{ '--sc': statusColor(lead.status) } as React.CSSProperties}>{STATUS_LABELS[lead.status]}</span></td>
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
    </div>
  )
}
