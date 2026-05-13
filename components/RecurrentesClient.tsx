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

export default function RecurrentesClient() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [dateRange, setDateRange] = useState<DateRange>('todo')
  const [bucket, setBucket] = useState<TicketBucket>('todos')
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<{ key: 'total' | 'veces' | 'fecha' | 'cliente' | 'avg'; dir: 'asc' | 'desc' }>(
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
      // Hidden filter
      if (c.hidden && !showHidden) return false
      // Date filter: usa fecha_inicio del cliente
      if (from || to) {
        if (!c.fecha_inicio) return false
        const t = new Date(c.fecha_inicio + 'T00:00:00').getTime()
        if (from && t < from.getTime()) return false
        if (to && t >= to.getTime()) return false
      }
      // Bucket
      if (bucket !== 'todos' && bucketOf(c) !== bucket) return false
      // Search
      if (q) {
        const hay = (c.cliente + ' ' + (c.email || '') + ' ' + c.canales.join(' ') + ' ' + (c.notas || '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [data, dateRange, bucket, search, showHidden])

  // ── Sorted ──
  const clientes = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'total': return dir * (a.total_pagado - b.total_pagado)
        case 'veces': return dir * (a.veces - b.veces)
        case 'avg': return dir * (avgTicket(a) - avgTicket(b))
        case 'fecha': return dir * (String(a.fecha_inicio || '').localeCompare(String(b.fecha_inicio || '')))
        case 'cliente': return dir * a.cliente.localeCompare(b.cliente)
      }
    })
  }, [filtered, sort])

  // ── Analytics del tab (sobre los filtrados) ──
  const analytics = useMemo(() => {
    const total = filtered.reduce((s, c) => s + c.total_pagado, 0)
    const pagos = filtered.reduce((s, c) => s + c.veces, 0)
    const avgTotal = filtered.length > 0 ? total / filtered.length : 0
    const avgTicketAll = pagos > 0 ? total / pagos : 0
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
    // Revenue por mes (agrupar meses de todos los clientes)
    const monthRevenue = new Map<string, number>()
    for (const c of filtered) {
      // Repartimos el total entre los meses en que aparece (aproximación; el sheet
      // tiene una fila por pago pero acá agrupamos; este reparto es ilustrativo)
      const share = c.veces > 0 ? c.total_pagado / c.veces : 0
      for (const m of c.meses) {
        monthRevenue.set(m, (monthRevenue.get(m) || 0) + share)
      }
    }
    const monthsSorted = Array.from(monthRevenue.entries())
      .sort((a, b) => monthCompare(a[0], b[0]))
    return { total, pagos, avgTotal, avgTicketAll, top5, byBucket, monthsSorted }
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

        {/* Filters bar */}
        <div className={styles.filtersBar}>
          <label className={styles.filterLabel}>Fecha de inicio:</label>
          <select className={styles.filterSelect} value={dateRange} onChange={e => setDateRange(e.target.value as DateRange)}>
            {(Object.keys(DATE_LABELS) as DateRange[]).map(r => (
              <option key={r} value={r}>{DATE_LABELS[r]}</option>
            ))}
          </select>
          <label className={styles.filterLabel}>Ticket promedio:</label>
          <select className={styles.filterSelect} value={bucket} onChange={e => setBucket(e.target.value as TicketBucket)}>
            {(Object.keys(TICKET_LABELS) as TicketBucket[]).map(b => (
              <option key={b} value={b}>{TICKET_LABELS[b]}</option>
            ))}
          </select>
          {data && data.hidden_count > 0 && (
            <button
              className={showHidden ? styles.toggleActive : styles.toggle}
              onClick={() => setShowHidden(v => !v)}>
              {showHidden ? '👁 Ocultando' : '👁‍🗨 Mostrar'} eliminados ({data.hidden_count})
            </button>
          )}
          {(dateRange !== 'todo' || bucket !== 'todos' || search) && (
            <button className={styles.clearFilter} onClick={() => { setDateRange('todo'); setBucket('todos'); setSearch('') }}>
              Limpiar filtros
            </button>
          )}
        </div>

        <div className={styles.body}>
          {loading && !data && <div className={styles.empty}>Leyendo el sheet en vivo…</div>}
          {error && <div className={styles.error}>⚠️ {error}</div>}
          {data && (
            <>
              {/* Summary cards (basados en el subset filtrado) */}
              <div className={styles.summary}>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Clientes</div>
                  <div className={styles.summaryValue}>{filtered.length}</div>
                  <div className={styles.summarySub}>de {data.clientes.length} totales</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Total pagado</div>
                  <div className={styles.summaryValue}>{fmtMoney(analytics.total)}</div>
                  <div className={styles.summarySub}>{analytics.pagos} pagos</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Promedio por cliente</div>
                  <div className={styles.summaryValue}>{fmtMoney(analytics.avgTotal)}</div>
                  <div className={styles.summarySub}>ticket prom. {fmtMoney(analytics.avgTicketAll)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Meses leídos</div>
                  <div className={styles.summaryValue}>{data.meses_leidos.length} / {data.meses_intentados.length}</div>
                  <div className={styles.summarySub}>
                    {data.meses_leidos.length === 0 ? '⚠️ Ninguna tab cargó' : `desde ${data.meses_leidos[0]}`}
                  </div>
                </div>
              </div>

              {/* Analytics blocks */}
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
                                <div className={styles.topBar}>
                                  <div className={styles.topBarFill} style={{ width: `${pct}%` }} />
                                </div>
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

              {analytics.monthsSorted.length > 0 && (
                <section className={styles.timelineCard}>
                  <h3>Revenue por mes (estimado)</h3>
                  <div className={styles.timeline}>
                    {analytics.monthsSorted.map(([month, rev]) => {
                      const max = Math.max(...analytics.monthsSorted.map(x => x[1]), 1)
                      const pct = (rev / max) * 100
                      return (
                        <div key={month} className={styles.timelineBar}>
                          <div className={styles.timelineFill} style={{ height: `${pct}%` }} title={`${month}: ${fmtMoney(rev)}`} />
                          <div className={styles.timelineLabel}>{shortMonth(month)}</div>
                          <div className={styles.timelineValue}>{fmtMoneyShort(rev)}</div>
                        </div>
                      )
                    })}
                  </div>
                  <div className={styles.timelineNote}>
                    Estimación: el sheet tiene una fila por pago pero acá agrupo por cliente. Cada cliente reparte su total entre los meses en que aparece. Útil para ver tendencia, no para reportes contables.
                  </div>
                </section>
              )}

              {/* Tabla */}
              <section className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th onClick={() => onSort('cliente')}>Cliente{arrow('cliente')}</th>
                      <th>Email</th>
                      <th onClick={() => onSort('fecha')}>Inicio{arrow('fecha')}</th>
                      <th onClick={() => onSort('veces')} className={styles.right}>Pagos{arrow('veces')}</th>
                      <th onClick={() => onSort('avg')} className={styles.right}>Ticket prom.{arrow('avg')}</th>
                      <th onClick={() => onSort('total')} className={styles.right}>Total{arrow('total')}</th>
                      <th>Canal(es)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientes.length === 0 && (
                      <tr><td colSpan={8} className={styles.empty}>Sin matches con los filtros actuales.</td></tr>
                    )}
                    {clientes.map(c => (
                      <tr key={c.key} className={styles.row + (c.hidden ? ' ' + styles.rowHidden : '')} onClick={() => setEditing(c)}>
                        <td>
                          <div className={styles.clienteName}>
                            {c.cliente}
                            {c.hidden && <span className={styles.hiddenTag} title="Oculto">👁‍🗨</span>}
                            {c.has_override && !c.hidden && <span className={styles.overrideTag} title="Editado manualmente">✏️</span>}
                          </div>
                          {c.meses.length > 1 && (
                            <div className={styles.mesesBadge} title={c.meses.join(' · ')}>en {c.meses.length} meses</div>
                          )}
                          {c.notas && <div className={styles.notas} title={c.notas}>📝 {c.notas.slice(0, 60)}{c.notas.length > 60 ? '…' : ''}</div>}
                        </td>
                        <td className={styles.mono}>{c.email || '—'}</td>
                        <td>{fmtDate(c.fecha_inicio)}</td>
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
    if (nextHidden && !confirm(`¿Eliminar "${cliente.cliente}" de la lista?\n\nQueda oculto en /recurrentes pero el sheet no se toca. Lo podés restaurar desde el botón "Mostrar eliminados".`)) return
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
              <div><span>Meses</span><strong>{cliente.meses.join(' · ')}</strong></div>
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

// ─── Helpers ──────────────────────────────────────────────────────────────
const MESES_LIST = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
function monthCompare(a: string, b: string): number {
  const pa = a.split(' '), pb = b.split(' ')
  const ya = parseInt(pa[1] || '0'), yb = parseInt(pb[1] || '0')
  if (ya !== yb) return ya - yb
  return MESES_LIST.indexOf(pa[0]) - MESES_LIST.indexOf(pb[0])
}
function shortMonth(m: string): string {
  const [mes, y] = m.split(' ')
  return `${mes.slice(0, 3)} ${y.slice(2)}`
}
function fmtMoneyShort(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}
