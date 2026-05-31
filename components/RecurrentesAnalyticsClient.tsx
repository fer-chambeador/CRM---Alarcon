'use client'

import { useEffect, useState, useMemo } from 'react'
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

type Payload = {
  clientes: Cliente[]
  total_pagado_global: number
  generated_at: string
  error?: string
}

const ESTATUS_COLOR: Record<EstatusCliente, string> = {
  activo:  '#22d68a',
  renovar: '#f5c842',
  churn:   '#f05a5a',
}
const ESTATUS_LABEL: Record<EstatusCliente, string> = {
  activo:  'Activos',
  renovar: 'Por renovar',
  churn:   'Churn',
}
const TIPO_COLORS: Record<TipoCliente, string> = {
  pequeño:     '#4ea8f5',
  mediano:     '#7c6af7',
  grande:      '#f5c842',
  corporativo: '#22d68a',
}
const TIPO_LABEL: Record<TipoCliente, string> = {
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

export default function RecurrentesAnalyticsClient() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    fetch('/api/recurrentes', { cache: 'no-store' })
      .then(r => r.json())
      .then((j: Payload) => {
        if (cancelled) return
        if (j.error) { setError(j.error); setData(null) }
        else setData(j)
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'fetch falló') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const stats = useMemo(() => {
    if (!data) return null
    const visible = data.clientes.filter(c => !c.hidden)
    const total = visible.length
    if (total === 0) return null

    const totalRevenue = visible.reduce((s, c) => s + c.total_pagado, 0)
    const ltvPromedio = totalRevenue / total
    const ticketPromedio = visible.reduce((s, c) => s + c.ticket_promedio, 0) / total
    const mesesRenovacionPromedio = visible.reduce((s, c) => s + c.meses_renovando, 0) / total

    const byEstatus: Record<EstatusCliente, number> = { activo: 0, renovar: 0, churn: 0 }
    const byEstatusRevenue: Record<EstatusCliente, number> = { activo: 0, renovar: 0, churn: 0 }
    for (const c of visible) {
      byEstatus[c.estatus] += 1
      byEstatusRevenue[c.estatus] += c.total_pagado
    }

    const byTipo: Record<TipoCliente, { count: number; revenue: number; avgLtv: number }> = {
      pequeño:     { count: 0, revenue: 0, avgLtv: 0 },
      mediano:     { count: 0, revenue: 0, avgLtv: 0 },
      grande:      { count: 0, revenue: 0, avgLtv: 0 },
      corporativo: { count: 0, revenue: 0, avgLtv: 0 },
    }
    for (const c of visible) {
      byTipo[c.tipo_cliente].count += 1
      byTipo[c.tipo_cliente].revenue += c.total_pagado
    }
    for (const k of Object.keys(byTipo) as TipoCliente[]) {
      const b = byTipo[k]
      b.avgLtv = b.count > 0 ? b.revenue / b.count : 0
    }

    const byContrato: Record<TipoContrato, number> = { mensual: 0, semestral: 0, anual: 0 }
    for (const c of visible) byContrato[c.tipo_contrato] += 1

    // Top 10 LTV
    const top10 = [...visible].sort((a, b) => b.total_pagado - a.total_pagado).slice(0, 10)

    // Renovaciones próximas (3 meses adelante para semestrales/anuales)
    const today = new Date()
    const currentMonth = today.getMonth() + 1  // 1-12
    const upcoming: Array<Cliente & { _mes: number; _gap: number }> = []
    for (const c of visible) {
      if (c.mes_renovacion == null) continue
      let gap = c.mes_renovacion - currentMonth
      if (gap < 0) gap += 12
      if (gap <= 3) {
        upcoming.push(Object.assign({}, c, { _mes: c.mes_renovacion, _gap: gap }))
      }
    }
    upcoming.sort((a, b) => a._gap - b._gap)

    // Churn rate
    const churnRate = byEstatus.churn / total
    const activeRate = byEstatus.activo / total

    return {
      total, totalRevenue, ltvPromedio, ticketPromedio, mesesRenovacionPromedio,
      byEstatus, byEstatusRevenue,
      byTipo, byContrato,
      top10, upcoming,
      churnRate, activeRate,
    }
  }, [data])

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="recurrentes-analitica" />
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <h1>📊 Recurrentes — Analítica</h1>
        </header>

        <div className={styles.body}>
          {loading && !data && <div className={styles.empty}>Cargando…</div>}
          {error && <div className={styles.error}>⚠️ {error}</div>}
          {stats && (
            <>
              {/* KPI hero */}
              <div className={styles.kpiHero} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                <div className={styles.kpiHeroCard + ' ' + styles.kpiHeroPurple}>
                  <div className={styles.kpiHeroLabel}>Clientes activos</div>
                  <div className={styles.kpiHeroValue}>{stats.byEstatus.activo}</div>
                  <div className={styles.kpiHeroSub}>{(stats.activeRate * 100).toFixed(0)}% del total · {stats.total} clientes</div>
                </div>
                <div className={styles.kpiHeroCard + ' ' + styles.kpiHeroTeal}>
                  <div className={styles.kpiHeroLabel}>LTV promedio</div>
                  <div className={styles.kpiHeroValue}>{fmtMoney(stats.ltvPromedio)}</div>
                  <div className={styles.kpiHeroSub}>histórico por cliente</div>
                </div>
                <div className={styles.kpiHeroCard + ' ' + styles.kpiHeroIndigo}>
                  <div className={styles.kpiHeroLabel}>Revenue total</div>
                  <div className={styles.kpiHeroValue}>{fmtMoney(stats.totalRevenue)}</div>
                  <div className={styles.kpiHeroSub}>de todos los recurrentes</div>
                </div>
                <div className={styles.kpiHeroCard + ' ' + styles.kpiHeroIndigo}
                  style={{ background: 'linear-gradient(135deg, #5e1d3d 0%, #b03a5e 100%)' }}>
                  <div className={styles.kpiHeroLabel}>Churn rate</div>
                  <div className={styles.kpiHeroValue}>{(stats.churnRate * 100).toFixed(0)}%</div>
                  <div className={styles.kpiHeroSub}>{stats.byEstatus.churn} clientes &gt; 60d sin pagar</div>
                </div>
              </div>

              {/* Distribución por estatus */}
              <Card title="Distribución por estatus" subtitle="Cuántos clientes en cada estado y cuánto revenue representan">
                <table style={tableStyle}>
                  <thead>
                    <tr style={thRow}>
                      <th style={thLeft}>Estatus</th>
                      <th style={thRight}>Clientes</th>
                      <th style={thRight}>Revenue total</th>
                      <th style={thRight}>% del revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['activo', 'renovar', 'churn'] as EstatusCliente[]).map(s => {
                      const count = stats.byEstatus[s]
                      const rev = stats.byEstatusRevenue[s]
                      const pct = stats.totalRevenue > 0 ? (rev / stats.totalRevenue) * 100 : 0
                      return (
                        <tr key={s} style={tdRow}>
                          <td style={tdLeft}>
                            <span style={{
                              display: 'inline-block', width: 8, height: 8, borderRadius: 999,
                              background: ESTATUS_COLOR[s], marginRight: 8, verticalAlign: 'middle',
                            }} />
                            <strong style={{ color: ESTATUS_COLOR[s] }}>{ESTATUS_LABEL[s]}</strong>
                          </td>
                          <td style={tdRight}><strong>{count}</strong></td>
                          <td style={tdRight}>{fmtMoney(rev)}</td>
                          <td style={tdRight}>{pct.toFixed(0)}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </Card>

              {/* Distribución por tipo de cliente */}
              <Card title="Distribución por tipo de cliente" subtitle="Pequeño <$5k · Mediano <$20k · Grande <$50k · Corporativo ≥$50k (basado en ticket promedio)">
                <table style={tableStyle}>
                  <thead>
                    <tr style={thRow}>
                      <th style={thLeft}>Tipo</th>
                      <th style={thRight}>Clientes</th>
                      <th style={thRight}>Revenue</th>
                      <th style={thRight}>LTV promedio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['corporativo', 'grande', 'mediano', 'pequeño'] as TipoCliente[]).map(t => {
                      const b = stats.byTipo[t]
                      return (
                        <tr key={t} style={tdRow}>
                          <td style={tdLeft}>
                            <span style={{
                              display: 'inline-block', width: 8, height: 8, borderRadius: 999,
                              background: TIPO_COLORS[t], marginRight: 8, verticalAlign: 'middle',
                            }} />
                            <strong>{TIPO_LABEL[t]}</strong>
                          </td>
                          <td style={tdRight}>{b.count}</td>
                          <td style={tdRight}>{fmtMoney(b.revenue)}</td>
                          <td style={tdRight}><strong>{fmtMoney(b.avgLtv)}</strong></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </Card>

              {/* Distribución por contrato */}
              <Card title="Tipo de contrato" subtitle="Calculado a partir de la mediana de gaps entre pagos">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
                  {(['mensual', 'semestral', 'anual'] as TipoContrato[]).map(c => (
                    <div key={c} style={{
                      background: 'var(--glass)', border: '1px solid var(--border)',
                      borderRadius: 12, padding: '16px 18px', textAlign: 'center',
                    }}>
                      <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
                        {CONTRATO_LABEL[c]}
                      </div>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color: 'var(--text)', marginTop: 6 }}>
                        {stats.byContrato[c]}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                        {((stats.byContrato[c] / stats.total) * 100).toFixed(0)}% del total
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Top 10 por LTV */}
              <Card title="Top 10 por LTV" subtitle="Los clientes que más valen históricamente — protégelos">
                <table style={tableStyle}>
                  <thead>
                    <tr style={thRow}>
                      <th style={thLeft}>#</th>
                      <th style={thLeft}>Cliente</th>
                      <th style={thLeft}>Tipo</th>
                      <th style={thLeft}>Contrato</th>
                      <th style={thRight}>Meses</th>
                      <th style={thRight}>LTV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.top10.map((c, i) => (
                      <tr key={c.key} style={tdRow}>
                        <td style={tdLeft}>
                          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, color: 'var(--text3)' }}>
                            {i + 1}
                          </span>
                        </td>
                        <td style={tdLeft}><strong>{c.cliente}</strong></td>
                        <td style={tdLeft}>
                          <span style={{ color: TIPO_COLORS[c.tipo_cliente], fontSize: 11.5 }}>
                            {TIPO_LABEL[c.tipo_cliente]}
                          </span>
                        </td>
                        <td style={tdLeft}>{CONTRATO_LABEL[c.tipo_contrato]}</td>
                        <td style={tdRight}>{c.meses_renovando}</td>
                        <td style={tdRight}>
                          <strong style={{ color: 'var(--green)', fontFamily: 'var(--font-display)' }}>
                            {fmtMoney(c.total_pagado)}
                          </strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              {/* Renovaciones próximas */}
              {stats.upcoming.length > 0 && (
                <Card title="Renovaciones en los próximos 3 meses"
                  subtitle="Clientes con contrato semestral o anual cuya renovación cae cerca — agendá el touchpoint">
                  <table style={tableStyle}>
                    <thead>
                      <tr style={thRow}>
                        <th style={thLeft}>Cliente</th>
                        <th style={thLeft}>Contrato</th>
                        <th style={thLeft}>Renueva en</th>
                        <th style={thRight}>LTV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.upcoming.map(c => (
                        <tr key={c.key} style={tdRow}>
                          <td style={tdLeft}><strong>{c.cliente}</strong></td>
                          <td style={tdLeft}>{CONTRATO_LABEL[c.tipo_contrato]}</td>
                          <td style={tdLeft}>
                            <strong style={{ color: c._gap === 0 ? '#f5c842' : 'var(--text)' }}>
                              {MES_NAMES[c._mes - 1]}
                              {c._gap === 0 && <span style={{ marginLeft: 6, fontSize: 10.5, color: '#f5c842' }}>este mes</span>}
                            </strong>
                          </td>
                          <td style={tdRight}>{fmtMoney(c.total_pagado)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}

              <div className={styles.footer}>
                Última actualización: {new Date(data!.generated_at).toLocaleString('es-MX')} · datos en vivo del Google Sheet · cache 60s
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{
      background: 'var(--glass)',
      backdropFilter: 'blur(12px)',
      border: '1px solid var(--border)',
      borderRadius: 16, padding: '20px 24px',
    }}>
      <header style={{ marginBottom: 14 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{title}</h3>
        {subtitle && <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginTop: 3 }}>{subtitle}</span>}
      </header>
      {children}
    </section>
  )
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
const thRow: React.CSSProperties = { borderBottom: '1px solid var(--border)' }
const thLeft: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text3)' }
const thRight: React.CSSProperties = { textAlign: 'right', padding: '8px 10px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text3)' }
const tdRow: React.CSSProperties = { borderBottom: '1px solid var(--border)' }
const tdLeft: React.CSSProperties = { textAlign: 'left', padding: '10px 10px', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }
const tdRight: React.CSSProperties = { textAlign: 'right', padding: '10px 10px', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }
