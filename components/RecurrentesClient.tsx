'use client'

import { useEffect, useState, useCallback } from 'react'
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
}

type Payload = {
  clientes: Cliente[]
  meses_leidos: string[]
  meses_intentados: string[]
  total_pagado_global: number
  generated_at: string
  error?: string
}

const fmtDate = (s: string | null) => {
  if (!s) return '—'
  const d = new Date(s + 'T00:00:00')
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function RecurrentesClient() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: 'total' | 'veces' | 'fecha' | 'cliente'; dir: 'asc' | 'desc' }>({ key: 'total', dir: 'desc' })

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

  const clientes = (data?.clientes || [])
    .filter(c => {
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return c.cliente.toLowerCase().includes(q)
        || (c.email || '').toLowerCase().includes(q)
        || c.canales.some(x => x.toLowerCase().includes(q))
    })
    .sort((a, b) => {
      const dir = sort.dir === 'asc' ? 1 : -1
      switch (sort.key) {
        case 'total': return dir * (a.total_pagado - b.total_pagado)
        case 'veces': return dir * (a.veces - b.veces)
        case 'fecha': return dir * (String(a.fecha_inicio || '').localeCompare(String(b.fecha_inicio || '')))
        case 'cliente': return dir * a.cliente.localeCompare(b.cliente)
      }
    })

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
          <input className={styles.search} placeholder="Buscar cliente o canal..."
            value={search} onChange={e => setSearch(e.target.value)} />
          <button className={styles.refreshBtn} onClick={load} disabled={loading}>
            {loading ? '…' : '↻ Refrescar'}
          </button>
        </header>

        <div className={styles.body}>
          {loading && <div className={styles.empty}>Leyendo el sheet en vivo…</div>}
          {error && <div className={styles.error}>⚠️ {error}</div>}
          {data && (
            <>
              <div className={styles.summary}>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Clientes</div>
                  <div className={styles.summaryValue}>{clientes.length}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Total pagado histórico</div>
                  <div className={styles.summaryValue}>{fmtMoney(data.total_pagado_global)}</div>
                </div>
                <div className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>Meses leídos</div>
                  <div className={styles.summaryValue}>{data.meses_leidos.length} / {data.meses_intentados.length}</div>
                  <div className={styles.summarySub}>
                    {data.meses_leidos.length === 0
                      ? '⚠️ Ninguna tab cargó. Revisá nombres y permisos del sheet.'
                      : `desde ${data.meses_leidos[0]}`}
                  </div>
                </div>
              </div>

              <section className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th onClick={() => onSort('cliente')}>Cliente{arrow('cliente')}</th>
                      <th>Email</th>
                      <th onClick={() => onSort('fecha')}>Inicio{arrow('fecha')}</th>
                      <th onClick={() => onSort('veces')} className={styles.right}>Pagos{arrow('veces')}</th>
                      <th onClick={() => onSort('total')} className={styles.right}>Total{arrow('total')}</th>
                      <th>Canal(es)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientes.length === 0 && (
                      <tr><td colSpan={6} className={styles.empty}>Sin clientes recurrentes registrados (o ningún match para Fer).</td></tr>
                    )}
                    {clientes.map(c => (
                      <tr key={c.key}>
                        <td><div className={styles.clienteName}>{c.cliente}</div>
                          {c.meses.length > 1 && (
                            <div className={styles.mesesBadge} title={c.meses.join(' · ')}>
                              en {c.meses.length} meses
                            </div>
                          )}
                        </td>
                        <td className={styles.mono}>{c.email || '—'}</td>
                        <td>{fmtDate(c.fecha_inicio)}</td>
                        <td className={styles.right}>{c.veces}</td>
                        <td className={styles.right + ' ' + styles.money}>{fmtMoney(c.total_pagado)}</td>
                        <td>
                          {c.canales.length === 0
                            ? <span className={styles.empty}>—</span>
                            : c.canales.map((ch, i) => (
                                <span key={i} className={styles.canalChip}>{ch}</span>
                              ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <div className={styles.footer}>
                Última actualización: {new Date(data.generated_at).toLocaleString('es-MX')} · datos vienen en vivo del Google Sheet · cache 60s
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
