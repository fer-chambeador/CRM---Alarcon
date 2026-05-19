'use client'

import { useMemo, useState } from 'react'
import { type Lead } from '@/lib/supabase'
import { startOfDay, startOfWeek, startOfMonth, endOfMonth, subMonths, format, eachDayOfInterval } from 'date-fns'
import { es } from 'date-fns/locale'
import clsx from 'clsx'
import styles from './AnalyticsClient.module.css'
import { Sidebar } from './CommandCenter'
import {
  STATUS_LABELS, STATUS_ORDER, PIPELINE_CLOSED, PIPELINE_CLOSING,
  DEFAULT_MONTO, statusColor, fmtMoney, fmtPct,
} from '@/lib/status'
import { phoneToState } from '@/lib/lada'
import { fmtPresupuesto } from '@/lib/budget'
import { forecastLeads, forecastByStage } from '@/lib/forecast'
import { agingByStage, cycleStats, agingBucket, AGING_COLOR } from '@/lib/velocity'

type DateRange = 'todo' | 'hoy' | 'semana' | 'mes' | 'mes-pasado'
const DATE_LABELS: Record<DateRange, string> = {
  todo: 'Todo el tiempo',
  hoy: 'Hoy',
  semana: 'Esta semana',
  mes: 'Este mes',
  'mes-pasado': 'Mes pasado',
}
function dateRangeBounds(range: DateRange): { from: Date | null; to: Date | null } {
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
  }
}

const sumMonto = (rows: Lead[]) => rows.reduce((a, l) => a + (l.monto ?? DEFAULT_MONTO), 0)

// ─── Bar (inline, no chart lib) ──────────────────────────────────────────────
function Bar({ value, max, color = '#7c6af7' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0
  return <div className={styles.bar}><div className={styles.barFill} style={{ width: `${pct}%`, background: color }} /></div>
}

// ─── Breakdown table ─────────────────────────────────────────────────────────
type BreakdownRow = { key: string; leads: number; pipeline: number; cerrados: number; pipelineCerrado: number }
type BreakdownSortKey = 'key' | 'leads' | 'pipeline' | 'cerrados' | 'convrate' | 'pipelineCerrado'

function makeBreakdown(leads: Lead[], keyOf: (l: Lead) => string | null): BreakdownRow[] {
  const map = new Map<string, BreakdownRow>()
  for (const l of leads) {
    const k = keyOf(l) || '— sin dato —'
    const row = map.get(k) || { key: k, leads: 0, pipeline: 0, cerrados: 0, pipelineCerrado: 0 }
    row.leads += 1
    row.pipeline += l.monto ?? DEFAULT_MONTO
    if (PIPELINE_CLOSED.includes(l.status)) {
      row.cerrados += 1
      row.pipelineCerrado += l.monto ?? DEFAULT_MONTO
    }
    map.set(k, row)
  }
  return Array.from(map.values())
}

function BreakdownTable({ title, subtitle, rows }: { title: string; subtitle: string; rows: BreakdownRow[] }) {
  const [sort, setSort] = useState<{ key: BreakdownSortKey; dir: 'asc' | 'desc' }>({ key: 'pipeline', dir: 'desc' })

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1
    const get = (r: BreakdownRow): number | string => {
      switch (sort.key) {
        case 'key':            return r.key.toLowerCase()
        case 'leads':          return r.leads
        case 'pipeline':       return r.pipeline
        case 'cerrados':       return r.cerrados
        case 'convrate':       return r.leads > 0 ? r.cerrados / r.leads : 0
        case 'pipelineCerrado':return r.pipelineCerrado
      }
    }
    return [...rows].sort((a, b) => {
      const av = get(a), bv = get(b)
      if (av < bv) return -1 * dir
      if (av > bv) return  1 * dir
      return 0
    })
  }, [rows, sort])

  const onSort = (key: BreakdownSortKey) => {
    setSort(s => s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'key' ? 'asc' : 'desc' })
  }
  const arrow = (key: BreakdownSortKey) =>
    sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const max = rows.length ? Math.max(...rows.map(r => r.pipeline)) : 0
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <h3>{title}</h3>
        <span className={styles.sectionSubtitle}>{subtitle}</span>
      </header>
      {rows.length === 0
        ? <div className={styles.empty}>Sin datos en este rango.</div>
        : (
          <table className={styles.breakdownTable}>
            <thead>
              <tr>
                <th onClick={() => onSort('key')}              style={{ cursor: 'pointer' }}>Categoría{arrow('key')}</th>
                <th onClick={() => onSort('leads')}            style={{ cursor: 'pointer' }}>Leads{arrow('leads')}</th>
                <th onClick={() => onSort('pipeline')}         style={{ cursor: 'pointer' }}>Pipeline{arrow('pipeline')}</th>
                <th onClick={() => onSort('cerrados')}         style={{ cursor: 'pointer' }}>Convertidos{arrow('cerrados')}</th>
                <th onClick={() => onSort('convrate')}         style={{ cursor: 'pointer' }}>Conv. rate{arrow('convrate')}</th>
                <th onClick={() => onSort('pipelineCerrado')}  style={{ cursor: 'pointer' }}>Cerrado{arrow('pipelineCerrado')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.key}>
                  <td className={styles.breakdownKey}>
                    <div>{r.key}</div>
                    <Bar value={r.pipeline} max={max} />
                  </td>
                  <td>{r.leads}</td>
                  <td>{fmtMoney(r.pipeline)}</td>
                  <td>{r.cerrados}</td>
                  <td>{fmtPct(r.cerrados / r.leads)}</td>
                  <td>{fmtMoney(r.pipelineCerrado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </section>
  )
}

// ─── Funnel ──────────────────────────────────────────────────────────────────
function FunnelChart({ leads }: { leads: Lead[] }) {
  const counts = STATUS_ORDER.map(s => ({
    s, label: STATUS_LABELS[s], count: leads.filter(l => l.status === s).length,
    monto: sumMonto(leads.filter(l => l.status === s)),
  }))
  const max = Math.max(...counts.map(c => c.count), 1)
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <h3>Funnel por status</h3>
        <span className={styles.sectionSubtitle}>Estado actual de los leads en el rango</span>
      </header>
      <div className={styles.funnel}>
        {counts.map(c => (
          <div key={c.s} className={styles.funnelRow}>
            <div className={styles.funnelLabel}>{c.label}</div>
            <div className={styles.funnelBarWrap}>
              <Bar value={c.count} max={max} color={statusColor(c.s)} />
            </div>
            <div className={styles.funnelCount}>{c.count}</div>
            <div className={styles.funnelMoney}>{fmtMoney(c.monto)}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── Daily timeline ──────────────────────────────────────────────────────────
function DailyTimeline({ leads, range }: { leads: Lead[]; range: DateRange }) {
  if (range === 'todo' || range === 'hoy') return null
  const { from, to } = dateRangeBounds(range)
  if (!from) return null
  const days = eachDayOfInterval({ start: from, end: to || new Date() })
  if (days.length > 95) return null

  const data = days.map(d => {
    const dayKey = format(d, 'yyyy-MM-dd')
    const dayLeads = leads.filter(l => format(new Date(l.created_at), 'yyyy-MM-dd') === dayKey)
    return {
      day: d,
      leads: dayLeads.length,
      pipeline: sumMonto(dayLeads),
    }
  })
  const max = Math.max(...data.map(d => d.leads), 1)
  const total = data.reduce((a, d) => a + d.leads, 0)
  const avg = total / data.length

  // Show day-of-week labels only if the range is short enough to fit
  const showLabels = days.length <= 14
  const showWeekdays = days.length <= 31

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Por día</h3>
          <span className={styles.sectionSubtitle}>{total} leads · prom. {avg.toFixed(1)}/día · pico {max}</span>
        </div>
      </header>
      <div className={styles.timelineChart}>
        {data.map((d, i) => {
          const pct = max > 0 ? (d.leads / max) * 100 : 0
          return (
            <div key={i} className={styles.timelineDay}
              title={`${format(d.day, "EEEE d 'de' MMM", { locale: es })} — ${d.leads} leads · ${fmtMoney(d.pipeline)}`}>
              <div className={styles.timelineCount}>{d.leads || ''}</div>
              <div className={styles.timelineBarWrap}>
                <div className={styles.timelineBar}
                  style={{ height: d.leads === 0 ? '4px' : `${Math.max(pct, 8)}%`, opacity: d.leads === 0 ? 0.25 : 1 }} />
              </div>
              <div className={styles.timelineDate}>
                {showWeekdays && <span>{format(d.day, 'EEEEE', { locale: es }).toUpperCase()}</span>}
                {showLabels && <strong>{format(d.day, 'd', { locale: es })}</strong>}
                {!showLabels && (i === 0 || i === data.length - 1 || i % Math.ceil(days.length / 8) === 0) && (
                  <strong>{format(d.day, 'd MMM', { locale: es })}</strong>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── Forecast section ──────────────────────────────────────────────────────
function ForecastSection({ buckets, forecast, cerradoReal }: {
  buckets: ReturnType<typeof forecastByStage>
  forecast: number
  cerradoReal: number
}) {
  const max = buckets.length ? Math.max(...buckets.map(b => b.contribution)) : 0
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Proyección del periodo</h3>
          <span className={styles.sectionSubtitle}>
            Σ (monto × probabilidad de cierre por stage). Cerrado real {fmtMoney(cerradoReal)} · forecast total <strong style={{ color: '#7c6af7' }}>{fmtMoney(forecast)}</strong>
          </span>
        </div>
      </header>
      {buckets.length === 0
        ? <div className={styles.empty}>Sin leads en este rango.</div>
        : (
          <table className={styles.breakdownTable}>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Leads</th>
                <th>Monto nominal</th>
                <th>Prob.</th>
                <th>Aporta al forecast</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map(b => (
                <tr key={b.status}>
                  <td className={styles.breakdownKey}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: statusColor(b.status) }} />
                      <span>{STATUS_LABELS[b.status]}</span>
                    </div>
                    <Bar value={b.contribution} max={max} color={statusColor(b.status)} />
                  </td>
                  <td>{b.count}</td>
                  <td>{fmtMoney(b.monto)}</td>
                  <td>{Math.round(b.probability * 100)}%</td>
                  <td><strong>{fmtMoney(b.contribution)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </section>
  )
}

// ─── Velocity section ──────────────────────────────────────────────────────
function VelocitySection({ rows, cycle }: {
  rows: ReturnType<typeof agingByStage>
  cycle: ReturnType<typeof cycleStats>
}) {
  const rowsWithLeads = rows.filter(r => r.count > 0)
  const max = rowsWithLeads.length ? Math.max(...rowsWithLeads.map(r => r.medianDays)) : 0
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Velocidad del funnel</h3>
          <span className={styles.sectionSubtitle}>
            Días promedio que llevan los leads en su stage actual.{' '}
            {cycle.count > 0
              ? <>Ciclo Nuevo→Cerrado: mediana <strong>{cycle.medianDays.toFixed(0)} días</strong> · promedio {cycle.avgDays.toFixed(0)} d ({cycle.count} cerrados).</>
              : <>Aún no hay leads cerrados en este rango para medir el ciclo.</>}
          </span>
        </div>
      </header>
      {rowsWithLeads.length === 0
        ? <div className={styles.empty}>Sin leads en este rango.</div>
        : (
          <table className={styles.breakdownTable}>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Leads aquí</th>
                <th>Mediana (días)</th>
                <th>Promedio (días)</th>
                <th>Estancados &gt;14 d</th>
              </tr>
            </thead>
            <tbody>
              {rowsWithLeads.map(r => {
                const ab = agingBucket(r.medianDays)
                return (
                  <tr key={r.status}>
                    <td className={styles.breakdownKey}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: statusColor(r.status) }} />
                        <span>{r.label}</span>
                      </div>
                      <Bar value={r.medianDays} max={max} color={AGING_COLOR[ab]} />
                    </td>
                    <td>{r.count}</td>
                    <td><strong style={{ color: AGING_COLOR[ab] }}>{r.medianDays.toFixed(1)}</strong></td>
                    <td>{r.avgDays.toFixed(1)}</td>
                    <td>{r.stuckCount > 0 ? <strong style={{ color: '#f05a5a' }}>{r.stuckCount}</strong> : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
    </section>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────
export default function AnalyticsClient({ initialLeads }: { initialLeads: Lead[] }) {
  const [leads] = useState<Lead[]>(initialLeads)
  const [dateRange, setDateRange] = useState<DateRange>('mes')

  const scoped = useMemo(() => {
    const { from, to } = dateRangeBounds(dateRange)
    if (!from && !to) return leads
    return leads.filter(l => {
      const t = new Date(l.created_at).getTime()
      if (from && t < from.getTime()) return false
      if (to && t > to.getTime()) return false
      return true
    })
  }, [leads, dateRange])

  const stats = useMemo(() => {
    const total = scoped.length
    const cerrados = scoped.filter(l => PIPELINE_CLOSED.includes(l.status)).length
    return {
      total,
      pipeline: sumMonto(scoped),
      pipelineCierre: sumMonto(scoped.filter(l => PIPELINE_CLOSING.includes(l.status))),
      pipelineCerrado: sumMonto(scoped.filter(l => PIPELINE_CLOSED.includes(l.status))),
      conversionRate: total > 0 ? cerrados / total : 0,
      cerrados,
      forecast: forecastLeads(scoped),
      cycle: cycleStats(scoped),
    }
  }, [scoped])

  const stageAging = useMemo(() => agingByStage(scoped), [scoped])
  const forecastBuckets = useMemo(() => forecastByStage(scoped), [scoped])

  const byCanal = useMemo(() => makeBreakdown(scoped, l => l.canal_adquisicion), [scoped])
  const byPuesto = useMemo(() => makeBreakdown(scoped, l => l.puesto), [scoped])
  const byEstado = useMemo(() => makeBreakdown(scoped, l => l.estado || phoneToState(l.telefono)), [scoped])
  const byPresupuesto = useMemo(() => makeBreakdown(scoped, l => fmtPresupuesto(l.presupuesto)), [scoped])
  const byVacante = useMemo(() => makeBreakdown(scoped, l => l.vacante), [scoped])

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="analytics" />
        <div className={styles.dateBlock}>
          <div className={styles.dateLabel}>Rango</div>
          <select className={styles.dateSelect} value={dateRange} onChange={e => setDateRange(e.target.value as DateRange)}>
            {(Object.keys(DATE_LABELS) as DateRange[]).map(r => (
              <option key={r} value={r}>{DATE_LABELS[r]}</option>
            ))}
          </select>
        </div>
        <div className={styles.kpiList}>
          <div className={styles.kpi}><span>Leads</span><strong>{stats.total}</strong></div>
          <div className={styles.kpi}><span>Convertidos</span><strong>{stats.cerrados}</strong></div>
          <div className={styles.kpi}><span>Conv. rate</span><strong>{fmtPct(stats.conversionRate)}</strong></div>
          <div className={styles.kpi}
            title="Mediana de días entre la creación del lead y el cambio a 'convertido' o 'cliente recurrente'">
            <span>Ciclo Nuevo→Cerrado</span>
            <strong>{stats.cycle.count > 0 ? `${stats.cycle.medianDays.toFixed(0)} d` : '—'}</strong>
          </div>
          <div className={styles.kpiMoney}><span>Pipeline total</span><strong>{fmtMoney(stats.pipeline)}</strong></div>
          <div className={styles.kpiMoney}><span>En cierre</span><strong style={{ color: '#a594ff' }}>{fmtMoney(stats.pipelineCierre)}</strong></div>
          <div className={styles.kpiMoney}><span>Cerrado</span><strong style={{ color: '#22d68a' }}>{fmtMoney(stats.pipelineCerrado)}</strong></div>
          <div className={styles.kpiMoney}
            title="Σ (monto × probabilidad de cierre por stage). Proyección ponderada del periodo.">
            <span>Forecast</span><strong style={{ color: '#7c6af7' }}>{fmtMoney(stats.forecast)}</strong>
          </div>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <h1>Analítica — {DATE_LABELS[dateRange]}</h1>
        </header>

        <div className={styles.body}>
          <FunnelChart leads={scoped} />
          <ForecastSection buckets={forecastBuckets} forecast={stats.forecast} cerradoReal={stats.pipelineCerrado} />
          <VelocitySection rows={stageAging} cycle={stats.cycle} />
          <BreakdownTable title="Por canal" subtitle="Qué canales generan más pipeline" rows={byCanal} />
          <BreakdownTable title="Por estado (LADA)" subtitle="De dónde se están registrando los leads" rows={byEstado} />
          <BreakdownTable title="Por presupuesto" subtitle="Tier de inversión declarado en onboarding" rows={byPresupuesto} />
          <BreakdownTable title="Por vacante (puesto buscado)" subtitle="Qué roles está reclutando el cliente — clave para entender qué anuncios convierten mejor" rows={byVacante} />
          <BreakdownTable title="Por decision maker (puesto)" subtitle="Qué roles convierten mejor" rows={byPuesto} />
          <DailyTimeline leads={scoped} range={dateRange} />
        </div>
      </main>
    </div>
  )
}
