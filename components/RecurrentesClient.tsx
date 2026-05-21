'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { Sidebar } from './CommandCenter'
import { fmtMoney } from '@/lib/status'
import styles from './RecurrentesClient.module.css'

type Pago = {
  fecha: string | null
  monto: number
  canal: string | null
  mes: string
}
type EstatusCliente = 'activo' | 'renovar' | 'churn'
type TipoCliente = 'pequeño' | 'mediano' | 'grande' | 'corporativo'
type TipoContrato = 'mensual' | 'semestral' | 'anual'

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
  meses_renovando: number
  pagos: Pago[]
  estatus: EstatusCliente
  tipo_cliente: TipoCliente
  ticket_promedio: number
  tipo_contrato: TipoContrato
  mes_renovacion: number | null
  notas: string | null
  has_override: boolean
  hidden: boolean
}

const ESTATUS_COLOR: Record<EstatusCliente, string> = {
  activo:  '#22d68a',
  renovar: '#f5c842',
  churn:   '#f05a5a',
}
const ESTATUS_LABEL: Record<EstatusCliente, string> = {
  activo:  'Activo',
  renovar: 'Por renovar',
  churn:   'Churn',
}
const TIPO_CLIENTE_LABEL: Record<TipoCliente, string> = {
  pequeño:     'Pequeño',
  mediano:     'Mediano',
  grande:      'Grande',
  corporativo: 'Corporativo',
}
const CONTRATO_LABEL: Record<TipoContrato, string> = {
  mensual:    'Mensual',
  semestral:  'Semestral',
  anual:      'Anual',
}
const MES_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

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
type TicketBucket = 'todos' | 'low' | 'mid' | 'high'
const TICKET_LABELS: Record<TicketBucket, string> = {
  todos: 'Todos los tickets',
  low: 'Tickets chicos (< $2,000)',
  mid: 'Tickets medianos ($2k–$10k)',
  high: 'Tickets grandes (≥ $10k)',
}
function avgTicket(c: Cliente): number {
  return c.ticket_promedio || (c.veces > 0 ? c.total_pagado / c.veces : 0)
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
  const [fechaDesde, setFechaDesde] = useState<string>('')
  const [fechaHasta, setFechaHasta] = useState<string>('')
  const [bucket, setBucket] = useState<TicketBucket>('todos')
  const [vigencia, setVigencia] = useState<Vigencia>('todos')
  const [filterEstatus, setFilterEstatus] = useState<'todos' | EstatusCliente>('todos')
  const [filterTipoCliente, setFilterTipoCliente] = useState<'todos' | TipoCliente>('todos')
  const [filterContrato, setFilterContrato] = useState<'todos' | TipoContrato>('todos')
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState<string | null>(null)
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
    const q = search.trim().toLowerCase()
    return data.clientes.filter(c => {
      // Eliminados nunca aparecen (sin toggle)
      if (c.hidden) return false
      // Fecha de inicio — calendar range (inclusive en ambos extremos)
      if (fechaDesde || fechaHasta) {
        if (!c.fecha_inicio) return false
        if (fechaDesde && c.fecha_inicio < fechaDesde) return false
        if (fechaHasta && c.fecha_inicio > fechaHasta) return false
      }
      // Bucket
      if (bucket !== 'todos' && bucketOf(c) !== bucket) return false
      // Vigencia (basado en última aparición)
      if (!isInRange(c.ultima_aparicion, vigencia)) return false
      // Estatus
      if (filterEstatus !== 'todos' && c.estatus !== filterEstatus) return false
      // Tipo cliente
      if (filterTipoCliente !== 'todos' && c.tipo_cliente !== filterTipoCliente) return false
      // Contrato
      if (filterContrato !== 'todos' && c.tipo_contrato !== filterContrato) return false
      // Search
      if (q) {
        const hay = (c.cliente + ' ' + (c.email || '') + ' ' + c.canales.join(' ') + ' ' + (c.notas || '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [data, fechaDesde, fechaHasta, bucket, vigencia, filterEstatus, filterTipoCliente, filterContrato, search])

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

  // ── KPIs (basados en filtered) ──
  const analytics = useMemo(() => {
    const total = filtered.reduce((s, c) => s + c.total_pagado, 0)
    const pagos = filtered.reduce((s, c) => s + c.veces, 0)
    // Clientes adquiridos este mes (calendar month en curso)
    const now = new Date()
    const ymPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const nuevosEsteMes = filtered.filter(c => c.fecha_inicio && c.fecha_inicio.startsWith(ymPrefix)).length
    return { total, pagos, nuevosEsteMes }
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
          <button className={styles.refreshBtn}
            onClick={async () => {
              setEnriching(true); setEnrichMsg(null)
              try {
                const res = await fetch('/api/recurrentes/enrich-emails', { method: 'POST' })
                const j = await res.json()
                if (j.error) throw new Error(j.error)
                setEnrichMsg(`✓ Enriquecidos ${j.applied} de ${j.total_sin_email} clientes sin email (${(j.duration_ms/1000).toFixed(1)}s)`)
                load()
              } catch (e) {
                setEnrichMsg(`⚠️ ${e instanceof Error ? e.message : 'falló'}`)
              } finally {
                setEnriching(false)
                setTimeout(() => setEnrichMsg(null), 8000)
              }
            }}
            disabled={enriching || loading}
            title="Busca emails faltantes cruzando con la tabla `leads` del CRM">
            {enriching ? '…' : '✉ Enriquecer emails'}
          </button>
        </header>
        {enrichMsg && (
          <div style={{ padding: '8px 32px', fontSize: 12, color: 'var(--text2)' }}>{enrichMsg}</div>
        )}

        {/* KPI Hero (estilo /leads) */}
        {data && (
          <div className={styles.kpiHero}>
            <div className={styles.kpiHeroCard + ' ' + styles.kpiHeroPurple}>
              <div className={styles.kpiHeroLabel}>Clientes recurrentes</div>
              <div className={styles.kpiHeroValue}>{filtered.length}</div>
              <div className={styles.kpiHeroSub}>{analytics.pagos} pagos totales</div>
            </div>
            <div className={styles.kpiHeroCard + ' ' + styles.kpiHeroTeal}>
              <div className={styles.kpiHeroLabel}>Total pagado</div>
              <div className={styles.kpiHeroValue}>{fmtMoney(analytics.total)}</div>
              <div className={styles.kpiHeroSub}>en el filtro actual</div>
            </div>
            <div className={styles.kpiHeroCard + ' ' + styles.kpiHeroIndigo}>
              <div className={styles.kpiHeroLabel}>Adquiridos este mes</div>
              <div className={styles.kpiHeroValue}>{analytics.nuevosEsteMes}</div>
              <div className={styles.kpiHeroSub}>primer pago en {new Date().toLocaleDateString('es-MX', { month: 'long' })}</div>
            </div>
          </div>
        )}

        <div className={styles.filtersBar}>
          <label className={styles.filterLabel}>Inicio desde:</label>
          <input type="date" className={styles.dateInput} value={fechaDesde}
            onChange={e => setFechaDesde(e.target.value)} max={fechaHasta || undefined} />
          <label className={styles.filterLabel}>hasta:</label>
          <input type="date" className={styles.dateInput} value={fechaHasta}
            onChange={e => setFechaHasta(e.target.value)} min={fechaDesde || undefined} />
          <label className={styles.filterLabel}>Monto (ticket):</label>
          <select className={styles.filterSelect} value={bucket} onChange={e => setBucket(e.target.value as TicketBucket)}>
            {(Object.keys(TICKET_LABELS) as TicketBucket[]).map(b => (
              <option key={b} value={b}>{TICKET_LABELS[b]}</option>
            ))}
          </select>
          <label className={styles.filterLabel}>Estatus:</label>
          <select className={styles.filterSelect} value={filterEstatus} onChange={e => setFilterEstatus(e.target.value as 'todos' | EstatusCliente)}>
            <option value="todos">Cualquier estatus</option>
            <option value="activo">Activo</option>
            <option value="renovar">Por renovar</option>
            <option value="churn">Churn</option>
          </select>
          <label className={styles.filterLabel}>Tipo:</label>
          <select className={styles.filterSelect} value={filterTipoCliente} onChange={e => setFilterTipoCliente(e.target.value as 'todos' | TipoCliente)}>
            <option value="todos">Cualquier tipo</option>
            <option value="pequeño">Pequeño</option>
            <option value="mediano">Mediano</option>
            <option value="grande">Grande</option>
            <option value="corporativo">Corporativo</option>
          </select>
          <label className={styles.filterLabel}>Contrato:</label>
          <select className={styles.filterSelect} value={filterContrato} onChange={e => setFilterContrato(e.target.value as 'todos' | TipoContrato)}>
            <option value="todos">Cualquier contrato</option>
            <option value="mensual">Mensual</option>
            <option value="semestral">Semestral</option>
            <option value="anual">Anual</option>
          </select>
          <label className={styles.filterLabel}>Vigencia:</label>
          <select className={styles.filterSelect} value={vigencia} onChange={e => setVigencia(e.target.value as Vigencia)}>
            {(Object.keys(VIGENCIA_LABELS) as Vigencia[]).map(v => (
              <option key={v} value={v}>{VIGENCIA_LABELS[v]}</option>
            ))}
          </select>
          {(fechaDesde || fechaHasta || bucket !== 'todos' || vigencia !== 'todos' || filterEstatus !== 'todos' || filterTipoCliente !== 'todos' || filterContrato !== 'todos' || search) && (
            <button className={styles.clearFilter} onClick={() => { setFechaDesde(''); setFechaHasta(''); setBucket('todos'); setVigencia('todos'); setFilterEstatus('todos'); setFilterTipoCliente('todos'); setFilterContrato('todos'); setSearch('') }}>
              Limpiar filtros
            </button>
          )}
        </div>

        <div className={styles.body}>
          {loading && !data && <div className={styles.empty}>Leyendo el sheet en vivo…</div>}
          {error && <div className={styles.error}>⚠️ {error}</div>}
          {data && (
            <>
              {/* Tabla principal */}
              <section className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th onClick={() => onSort('cliente')}>Cliente{arrow('cliente')}</th>
                      <th>Estatus</th>
                      <th>Tipo</th>
                      <th>Contrato</th>
                      <th onClick={() => onSort('fecha')}>Fecha de inicio{arrow('fecha')}</th>
                      <th onClick={() => onSort('ultima')}>Último pago{arrow('ultima')}</th>
                      <th onClick={() => onSort('veces')} className={styles.right}>Meses renov.{arrow('veces')}</th>
                      <th onClick={() => onSort('avg')} className={styles.right}>Ticket prom.{arrow('avg')}</th>
                      <th onClick={() => onSort('total')} className={styles.right}>Total{arrow('total')}</th>
                      <th>Canal(es)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientes.length === 0 && (
                      <tr><td colSpan={11} className={styles.empty}>Sin matches con los filtros actuales.</td></tr>
                    )}
                    {clientes.map(c => (
                      <tr key={c.key} className={styles.row} onClick={() => setEditing(c)}>
                        <td>
                          <div className={styles.clienteName}>
                            {c.cliente}
                            {c.has_override && <span className={styles.overrideTag} title="Editado manualmente">✏️</span>}
                          </div>
                          {c.email && <div className={styles.mono} style={{ marginTop: 2 }}>{c.email}</div>}
                          {c.notas && <div className={styles.notas} title={c.notas}>📝 {c.notas.slice(0, 60)}{c.notas.length > 60 ? '…' : ''}</div>}
                        </td>
                        <td>
                          <span className={styles.statusChip} style={{ '--ec': ESTATUS_COLOR[c.estatus] } as React.CSSProperties}>
                            {ESTATUS_LABEL[c.estatus]}
                          </span>
                        </td>
                        <td><span className={styles.tipoChip}>{TIPO_CLIENTE_LABEL[c.tipo_cliente]}</span></td>
                        <td>
                          <span className={styles.contratoChip}>{CONTRATO_LABEL[c.tipo_contrato]}</span>
                          {c.mes_renovacion && (
                            <div className={styles.renovacionHint} title="Mes estimado de próxima renovación">
                              → {MES_NAMES[c.mes_renovacion - 1]}
                            </div>
                          )}
                        </td>
                        <td>{fmtDate(c.fecha_inicio)}</td>
                        <td>{fmtDate(c.ultima_aparicion)}</td>
                        <td className={styles.right}>{c.meses_renovando}</td>
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
    canal: cliente.canales[0] || '',
    notas: cliente.notas || '',
    estatus: cliente.estatus as EstatusCliente,
    tipo_cliente: cliente.tipo_cliente as TipoCliente,
    tipo_contrato: cliente.tipo_contrato as TipoContrato,
    meses_renovando: cliente.meses_renovando,
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
            <span>Canal principal</span>
            <input value={form.canal} onChange={e => setForm(f => ({ ...f, canal: e.target.value }))}
              placeholder="Stripe, MercadoPago, OXXO, transferencia..." />
            <small className={styles.hint}>Detectado(s) en el sheet: {cliente.canales.join(', ') || '—'}</small>
          </label>

          {/* Overrides manuales — sobreescriben el cálculo automático */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <label className={styles.field}>
              <span>Estatus</span>
              <select value={form.estatus} onChange={e => setForm(f => ({ ...f, estatus: e.target.value as EstatusCliente }))}>
                <option value="activo">Activo</option>
                <option value="renovar">Por renovar</option>
                <option value="churn">Churn</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Tipo de cliente</span>
              <select value={form.tipo_cliente} onChange={e => setForm(f => ({ ...f, tipo_cliente: e.target.value as TipoCliente }))}>
                <option value="pequeño">Pequeño</option>
                <option value="mediano">Mediano</option>
                <option value="grande">Grande</option>
                <option value="corporativo">Corporativo</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Tipo de contrato</span>
              <select value={form.tipo_contrato} onChange={e => setForm(f => ({ ...f, tipo_contrato: e.target.value as TipoContrato }))}>
                <option value="mensual">Mensual</option>
                <option value="semestral">Semestral</option>
                <option value="anual">Anual</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Meses renovando</span>
              <input type="number" min={0} step={1} value={form.meses_renovando}
                onChange={e => setForm(f => ({ ...f, meses_renovando: Number(e.target.value) || 0 }))} />
            </label>
          </div>

          <label className={styles.field}>
            <span>Notas</span>
            <textarea rows={3} value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))}
              placeholder="Cualquier detalle relevante de este cliente..." />
          </label>

          <div className={styles.readonlySection}>
            <h4>Métricas del cliente</h4>
            <div className={styles.readonlyGrid}>
              <div><span>Fecha de inicio</span><strong>{fmtDate(cliente.fecha_inicio)}</strong></div>
              <div><span>Último pago</span><strong>{fmtDate(cliente.ultima_aparicion)}</strong></div>
              <div><span>Total pagado</span><strong>{fmtMoney(cliente.total_pagado)}</strong></div>
              <div><span>Pagos registrados</span><strong>{cliente.veces}</strong></div>
              {cliente.mes_renovacion && (
                <div><span>Próxima renovación</span>
                  <strong>{MES_NAMES[cliente.mes_renovacion - 1]}</strong>
                </div>
              )}
            </div>
          </div>

          {cliente.pagos && cliente.pagos.length > 0 && (
            <div className={styles.readonlySection}>
              <h4>Historial de pagos</h4>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 10.5, textTransform: 'uppercase', color: 'var(--text3)', fontWeight: 600, letterSpacing: '0.08em' }}>Fecha</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', fontSize: 10.5, textTransform: 'uppercase', color: 'var(--text3)', fontWeight: 600, letterSpacing: '0.08em' }}>Monto</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontSize: 10.5, textTransform: 'uppercase', color: 'var(--text3)', fontWeight: 600, letterSpacing: '0.08em' }}>Medio</th>
                  </tr>
                </thead>
                <tbody>
                  {cliente.pagos.map((p, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px', color: 'var(--text)' }}>{fmtDate(p.fecha)}</td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--green)', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(p.monto)}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text2)' }}>{p.canal || '—'}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ padding: '8px', color: 'var(--text3)', fontSize: 11 }}>Total ({cliente.pagos.length} pagos)</td>
                    <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--font-display)', fontWeight: 800, color: 'var(--text)' }}>{fmtMoney(cliente.total_pagado)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
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
