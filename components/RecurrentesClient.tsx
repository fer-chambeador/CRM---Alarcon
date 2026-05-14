'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { Sidebar } from './CommandCenter'
import { fmtMoney } from '@/lib/status'
import styles from './RecurrentesClient.module.css'

type Cliente = {
  key: string
  cliente: string
  email: string | null
  fecha_inicio: string | null
  ultima_aparicion: string | null
  total_pagado: number
  veces: number
  canales: string[]
  meses: string[]
  notas: string | null
  has_override: boolean
  hidden: boolean
}

type Payload = {
  clientes: Cliente[]
  meses_leidos: string[]
  meses_intentados: string[]
  total_pagado_global: number
  hidden_count: number
  generated_at: string
  error?: string
}

const fmtDate = (s: string | null) => {
  if (!s) return '—'
  const d = new Date(s + 'T00:00:00')
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' })
}

// ─── Filters ──────────────────────────────────────────────────────────────
type DateRange = 'todo' | '30d' | '90d' | '6m' | 'ytd' | 'year-current' | 'year-prev'
const DATE_LABELS: Record<DateRange, string> = {
  todo: 'Todo el tiempo',
  '30d': 'Últimos 30 días',
  '90d': 'Últimos 90 días',
  '6m': 'Últimos 6 meses',
  ytd: 'Este año',
  'year-current': new Date().getFullYear().toString(),
  'year-prev': (new Date().getFullYear() - 1).toString(),
}
function dateRangeBounds(r: DateRange): { from: Date | null; to: Date | null } {
  const now = new Date()
  switch (r) {
    case 'todo': return { from: null, to: null }
    case '30d': return { from: new Date(now.getTime() - 30 * 86400_000), to: null }
    case '90d': return { from: new Date(now.getTime() - 90 * 86400_000), to: null }
    case '6m': {
      const d = new Date(now); d.setMonth(d.getMonth() - 6); return { from: d, to: null }
    }
    case 'ytd': return { from: new Date(now.getFullYear(), 0, 1), to: null }
    case 'year-current': {
      const y = now.getFullYear()
      return { from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1) }
    }
    case 'year-prev': {
      const y = now.getFullYear() - 1
      return { from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1) }
    }
  }
}

type TicketBucket = 'todos' | 'low' | 'mid' | 'high'
const TICKET_LABELS: Record<TicketBucket, string> = {
  todos: 'Todos los tickets',
  low: 'Tickets chicos (< $2,000)',
  mid: 'Tickets medianos ($2k–$10k)',
  high: 'Tickets grandes (≥ $10k)',
}
function avgTicket(c: Cliente): number {
  return c.veces > 0 ? c.total_pagado / c.veces : 0
}
function bucketOf(c: Cliente): TicketBucket {
  const a = avgTicket(c)
  if (a >= 10000) return 'high'
  if (a >= 2000) return 'mid'
  return 'low'
}

type Vigencia = 'todos' | 'activo-30' | 'activo-90' | 'inactivo-90' | 'inactivo-180'
const VIGENCIA_LABELS: Record<Vigencia, string> = {
  todos: 'Cualquier vigencia',
  'activo-30': 'Activos (últimos 30 días)',
  'activo-90': 'Activos (últimos 90 días)',
  'inactivo-90': 'Inactivos (>90 días)',
  'inactivo-180': 'Inactivos (>180 días)',
}
function isInRange(lastSeen: string | null, vigencia: Vigencia, now = Date.now()): boolean {
  if (vigencia === 'todos') return true
  if (!lastSeen) return vigencia.startsWith('inactivo')
  const t = new Date(lastSeen + 'T00:00:00').getTime()
  const days = (now - t) / 86400_000
  switch (vigencia) {
    case 'activo-30': return days <= 30
    case 'activo-90': return days <= 90
    case 'inactivo-90': return days > 90
    case 'inactivo-180': return days > 180
  }
  return true
}

export default function RecurrentesClient() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState<DateRange>('todo')
  const [bucket, setBucket] = useState<TicketBucket>('todos')
  const [vigencia, setVigencia] = useState<Vigencia>('todos')
  const [sort, setSort] = useState<{ key: 'total' | 'veces' | 'fecha' | 'cliente' | 'avg' | 'ultima'; dir: 'asc' | 'desc' }>(
    { key: 'total', dir: 'desc' }
  )
  const [editing, setEditing] = useState<Cliente | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/recurrentes', { cache: 'no-store' })
      const json = (await res.json()) as Payload
      if (json.error) { setError(json.error); setData(null) }
      else setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch falló')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ── Filtros aplicados ──
  const filtered = useMemo(() => {
    if (!data) return []
    const { from, to } = dateRangeBounds(dateRange)
    const q = search.trim().toLowerCase()
    return data.clientes.filter(c => {
      // Eliminados nunca aparecen (sin toggle)
      if (c.hidden) return false
      // Fecha de inicio
      if (from || to) {
        if (!c.fecha_inicio) return false
        const t = new Date(c.fecha_inicio + 'T00:00:00').getTime()
        if (from && t < from.getTime()) return false
        if (to && t >= to.getTime()) return false
      }
      // Bucket
      if (bucket !== 'todos' && bucketOf(c) !== bucket) return false
      // Vigencia (basado en última aparición)
      if (!isInRange(c.ultima_aparicion, vigencia)) return false
      // Search
      if (q) {
        const hay = (c.cliente + ' ' + (c.email || '') + ' ' + c.canales.join(' ') + ' ' + (c.notas || '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [data, dateRange, bucket, vigencia, search])

  // ── Sorted ──
  const clientes = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'total': return dir * (a.total_pagado - b.total_pagado)
        case 'veces': return dir * (a.veces - b.veces)
        case 'avg': return dir * (avgTicket(a) - avgTicket(b))
        case 'fecha': return dir * (String(a.fecha_inicio || '').localeCompare(String(b.fecha_inicio || '')))
        case 'ultima': return dir * (String(a.ultima_aparicion || '').localeCompare(String(b.ultima_aparicion || '')))
        case 'cliente': return dir * a.cliente.localeCompare(b.cliente)
      }
    })
  }, [filtered, sort])

  // ── Top 5 + bucket dist (basados en filtered) ──
  const analytics = useMemo(() => {
    const total = filtered.reduce((s, c) => s + c.total_pagado, 0)
    const pagos = filtered.reduce((s, c) => s + c.veces, 0)
    const top5 = [...filtered].sort((a, b) => b.total_pagado - a.total_pagado).slice(0, 5)
    const byBucket: Record<TicketBucket, { count: number; total: number }> = {
      todos: { count: 0, total: 0 }, low: { count: 0, total: 0 },
      mid: { count: 0, total: 0 }, high: { count: 0, total: 0 },
    }
    for (const c of filtered) {
      const b = bucketOf(c)
      byBucket[b].count += 1
      byBucket[b].total += c.total_pagado
    }
    return { total, pagos, top5, byBucket }
  }, [filtered])

  const onSort = (key: typeof sort.key) => {
    setSort(s => s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'cliente' ? 'asc' : 'desc' })
  }
  const arrow = (key: typeof sort.key) => sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="recurrentes" />
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <h1>💎 Clientes recurrentes</h1>
          <div className={styles.topBarSpacer} />
          <input className={styles.search} placeholder="Buscar cliente, canal, notas..."
            value={search} onChange={e => setSearch(e.target.value)} />
          <button className={styles.refreshBtn} onClick={load} disabled={loading}>
            {loading ? '…' : '↻ Refrescar'}
          </button>
        </header>

        <div className={styles.filtersBar}>
          <label className={styles.filterLabel}>Fecha de inicio:</label>
          <select className={styles.filterSelect} value={dateRange} onChange={e => setDateRange(e.target.value as DateRange)}>
            {(Object.keys(DATE_LABELS) as DateRange[]).map(r => (
              <option key={r} value={r}>{DATE_LABELS[r]}</option>
            ))}
          </select>
          <label className={styles.filterLabel}>Monto (ticket):</label>
          <select className={styles.filterSelect} value={bucket} onChange={e => setBucket(e.target.value as TicketBucket)}>
            {(Object.keys(TICKET_LABELS) as TicketBucket[]).map(b => (
              <option key={b} value={b}>{TICKET_LABELS[b]}</option>
            ))}
          </select>
          <label className={styles.filterLabel}>Vigencia:</label>
          <select className={styles.filterSelect} value={vigencia} onChange={e => setVigencia(e.target.value as Vigencia)}>
            {(Object.keys(VIGENCIA_LABELS) as Vigencia[]).map(v => (
              <option key={v} value={v}>{VIGENCIA_LABELS[v]}</option>
            ))}
          </select>
          {(dateRange !== 'todo' || bucket !== 'todos' || vigencia !== 'todos' || search) && (
            <button className={styles.clearFilter} onClick={() => { setDateRange('todo'); setBucket('todos'); setVigencia('todos'); setSearch('') }}>
              Limpiar filtros
            </button>
          )}
        </div>

        <div className={styles.body}>
          {loading && !data && <div className={styles.empty}>Leyendo el sheet en vivo…</div>}
          {error && <div className={styles.error}>⚠️ {error}</div>}
          {data && (
            <>
              {/* Summary: 2 cards */}
              <div className={styles.summary}>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Clientes</div>
                  <div className={styles.summaryValue}>{filtered.length}</div>
                  <div className={styles.summarySub}>{analytics.pagos} pagos totales</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Total pagado</div>
                  <div className={styles.summaryValue}>{fmtMoney(analytics.total)}</div>
                  <div className={styles.summarySub}>en el filtro actual</div>
                </div>
              </div>

              {/* Analytics row: top 5 + dist */}
              <div className={styles.analyticsRow}>
                <section className={styles.analyticsCard}>
                  <h3>Top 5 por total pagado</h3>
                  {analytics.top5.length === 0
                    ? <div className={styles.empty}>—</div>
                    : <ul className={styles.topList}>
                        {analytics.top5.map((c, i) => {
                          const max = analytics.top5[0]?.total_pagado || 1
                          const pct = (c.total_pagado / max) * 100
                          return (
                            <li key={c.key} onClick={() => setEditing(c)}>
                              <div className={styles.topRank}>{i + 1}</div>
                              <div className={styles.topBody}>
                                <div className={styles.topName}>{c.cliente}</div>
                                <div className={styles.topBar}><div className={styles.topBarFill} style={{ width: `${pct}%` }} /></div>
                              </div>
                              <div className={styles.topAmount}>{fmtMoney(c.total_pagado)}</div>
                            </li>
                          )
                        })}
                      </ul>}
                </section>

                <section className={styles.analyticsCard}>
                  <h3>Distribución por ticket promedio</h3>
                  <ul className={styles.bucketList}>
                    {(['high','mid','low'] as TicketBucket[]).map(b => {
                      const v = analytics.byBucket[b]
                      const pctClients = filtered.length > 0 ? (v.count / filtered.length) * 100 : 0
                      return (
                        <li key={b}>
                          <div className={styles.bucketHeader}>
                            <span>{TICKET_LABELS[b]}</span>
                            <span className={styles.bucketCount}>{v.count}</span>
                          </div>
                          <div className={styles.topBar}><div className={styles.topBarFill} style={{ width: `${pctClients}%` }} /></div>
                          <div className={styles.bucketSub}>{fmtMoney(v.total)} en total</div>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              </div>

              {/* Tabla principal */}
              <section className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th onClick={() => onSort('cliente')}>Cliente{arrow('cliente')}</th>
                      <th>Email</th>
                      <th onClick={() => onSort('fecha')}>Inicio{arrow('fecha')}</th>
                      <th onClick={() => onSort('ultima')}>Última aparición{arrow('ultima')}</th>
                      <th onClick={() => onSort('veces')} className={styles.right}>Pagos{arrow('veces')}</th>
                      <th onClick={() => onSort('avg')} className={styles.right}>Ticket prom.{arrow('avg')}</th>
                      <th onClick={() => onSort('total')} className={styles.right}>Total{arrow('total')}</th>
                      <th>Canal(es)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientes.length === 0 && (
                      <tr><td colSpan={9} className={styles.empty}>Sin matches con los filtros actuales.</td></tr>
                    )}
                    {clientes.map(c => (
                      <tr key={c.key} className={styles.row} onClick={() => setEditing(c)}>
                        <td>
                          <div className={styles.clienteName}>
                            {c.cliente}
                            {c.has_override && <span className={styles.overrideTag} title="Editado manualmente">✏️</span>}
                          </div>
                          {c.meses.length > 1 && (
                            <div className={styles.mesesBadge} title={c.meses.join(' · ')}>en {c.meses.length} meses</div>
                          )}
                          {c.notas && <div className={styles.notas} title={c.notas}>📝 {c.notas.slice(0, 60)}{c.notas.length > 60 ? '…' : ''}</div>}
                        </td>
                        <td className={styles.mono}>{c.email || '—'}</td>
                        <td>{fmtDate(c.fecha_inicio)}</td>
                        <td>{fmtDate(c.ultima_aparicion)}</td>
                        <td className={styles.right}>{c.veces}</td>
                        <td className={styles.right + ' ' + styles.mono}>{fmtMoney(avgTicket(c))}</td>
                        <td className={styles.right + ' ' + styles.money}>{fmtMoney(c.total_pagado)}</td>
                        <td>
                          {c.canales.length === 0
                            ? <span className={styles.empty}>—</span>
                            : c.canales.map((ch, i) => <span key={i} className={styles.canalChip}>{ch}</span>)}
                        </td>
                        <td className={styles.editHint}>Editar →</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <div className={styles.footer}>
                Última actualización: {new Date(data.generated_at).toLocaleString('es-MX')} · datos en vivo del Google Sheet · cache 60s
              </div>
            </>
          )}
        </div>

        {editing && (
          <EditModal cliente={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />
        )}
      </main>
    </div>
  )
}

// ─── Edit modal ───────────────────────────────────────────────────────────
function EditModal({ cliente, onClose, onSaved }: {
  cliente: Cliente; onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState({
    nombre: cliente.cliente || '',
    email: cliente.email || '',
    fecha_inicio: cliente.fecha_inicio || '',
    canal: cliente.canales[0] || '',
    notas: cliente.notas || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(async () => {
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/recurrentes/${encodeURIComponent(cliente.key)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'guardado falló')
      setSaving(false)
    }
  }, [form, cliente.key, onSaved])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, save])

  const clearOverride = async () => {
    if (!confirm('¿Borrar los datos editados y volver a la versión del sheet?')) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/recurrentes/${encodeURIComponent(cliente.key)}`, { method: 'DELETE' })
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'borrado falló')
      setSaving(false)
    }
  }

  const toggleHidden = async () => {
    const nextHidden = !cliente.hidden
    if (nextHidden && !confirm(`¿Eliminar "${cliente.cliente}" de la lista?\n\nQueda oculto en /recurrentes pero el sheet no se toca.`)) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/recurrentes/${encodeURIComponent(cliente.key)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: nextHidden }),
      })
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'operación falló')
      setSaving(false)
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <div>
            <div className={styles.modalTitle}>💎 {cliente.cliente}</div>
            <div className={styles.modalMeta}>
              {cliente.veces} pago{cliente.veces !== 1 ? 's' : ''} · {fmtMoney(cliente.total_pagado)} histórico · en {cliente.meses.length} mes{cliente.meses.length !== 1 ? 'es' : ''}
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </header>

        <div className={styles.modalBody}>
          {error && <div className={styles.error}>⚠️ {error}</div>}

          <label className={styles.field}>
            <span>Nombre</span>
            <input value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
              placeholder="Nombre del cliente" />
          </label>

          <label className={styles.field}>
            <span>Email</span>
            <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="email@empresa.com" />
          </label>

          <label className={styles.field}>
            <span>Fecha de inicio</span>
            <input type="date" value={form.fecha_inicio} onChange={e => setForm(f => ({ ...f, fecha_inicio: e.target.value }))} />
            <small className={styles.hint}>Default: primer mes en el sheet ({fmtDate(cliente.fecha_inicio)}).</small>
          </label>

          <label className={styles.field}>
            <span>Canal principal</span>
            <input value={form.canal} onChange={e => setForm(f => ({ ...f, canal: e.target.value }))}
              placeholder="Stripe, MercadoPago, OXXO, transferencia..." />
            <small className={styles.hint}>Detectado(s) en el sheet: {cliente.canales.join(', ') || '—'}</small>
          </label>

          <label className={styles.field}>
            <span>Notas</span>
            <textarea rows={3} value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))}
              placeholder="Cualquier detalle relevante de este cliente..." />
          </label>

          <div className={styles.readonlySection}>
            <h4>Solo lectura (del sheet)</h4>
            <div className={styles.readonlyGrid}>
              <div><span>Total pagado</span><strong>{fmtMoney(cliente.total_pagado)}</strong></div>
              <div><span>Cantidad de pagos</span><strong>{cliente.veces}</strong></div>
              <div><span>Ticket promedio</span><strong>{fmtMoney(avgTicket(cliente))}</strong></div>
              <div><span>Última aparición</span><strong>{fmtDate(cliente.ultima_aparicion)}</strong></div>
            </div>
          </div>
        </div>

        <footer className={styles.modalFooter}>
          <button className={cliente.hidden ? styles.restoreBtn : styles.deleteBtn}
            onClick={toggleHidden} disabled={saving}
            title={cliente.hidden ? 'Volver a mostrar este cliente' : 'Ocultar de la lista (reversible)'}>
            {cliente.hidden ? '↩️ Restaurar' : '🗑 Eliminar'}
          </button>
          {cliente.has_override && !cliente.hidden && (
            <button className={styles.clearOverrideBtn} onClick={clearOverride} disabled={saving} title="Borrar nombre, email, canal y notas editados — vuelve a los valores del sheet">
              Limpiar ediciones
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className={styles.cancelBtn} onClick={onClose} disabled={saving}>Cancelar</button>
            <button className={styles.saveBtn} onClick={save} disabled={saving || cliente.hidden}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
