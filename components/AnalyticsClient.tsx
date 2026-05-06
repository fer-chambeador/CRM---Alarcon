'use client'

import { useMemo, useState } from 'react'
import { type Lead } from '@/lib/supabase'
import { startOfDay, startOfWeek, startOfMonth, subDays, format, eachDayOfInterval } from 'date-fns'
import { es } from 'date-fns/locale'
import clsx from 'clsx'
import styles from './AnalyticsClient.module.css'
import { Sidebar } from './CommandCenter'
import {
  STATUS_LABELS, STATUS_ORDER, PIPELINE_CLOSED, PIPELINE_CLOSING,
  DEFAULT_MONTO, statusColor, fmtMoney, fmtPct,
} from '@/lib/status'

type DateRange = 'todo' | 'hoy' | 'semana' | 'mes' | 'ultimos-30' | 'ultimos-90'
const DATE_LABELS: Record<DateRange, string> = {
  todo: 'Todo el tiempo',
  hoy: 'Hoy',
  semana: 'Esta semana',
  mes: 'Este mes',
  'ultimos-30': 'Últimos 30 días',
  'ultimos-90': 'Últimos 90 días',
}
function dateRangeStart(range: DateRange): Date | null {
  const now = new Date()
  switch (range) {
    case 'todo': return null
    case 'hoy': return startOfDay(now)
    case 'semana': return startOfWeek(now, { weekStartsOn: 1 })
    case 'mes': return startOfMonth(now)
    case 'ultimos-30': return subDays(now, 30)
    case 'ultimos-90': return subDays(now, 90)
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
  return Array.from(map.values()).sort((a, b) => b.pipeline - a.pipeline)
}

function BreakdownTable({ title, subtitle, rows }: { title: string; subtitle: string; rows: BreakdownRow[] }) {
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
                <th>Categoría</th>
                <th>Leads</th>
                <th>Pipeline</th>
                <th>Convertidos</th>
                <th>Conv. rate</th>
                <th>Cerrado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
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
  const start = dateRangeStart(range)!
  const days = eachDayOfInterval({ start, end: new Date() })
  if (days.length > 95) return null  // bail if range too wide

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

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <h3>Por día</h3>
        <span className={styles.sectionSubtitle}>Leads nuevos cada día en el rango</span>
      </header>
      <div className={styles.timelineChart}>
        {data.map((d, i) => (
          <div key={i} className={styles.timelineDay} title={`${format(d.day, "d 'de' MMM", { locale: es })} — ${d.leads} leads · ${fmtMoney(d.pipeline)}`}>
            <div className={styles.timelineBar} style={{ height: `${(d.leads / max) * 100}%` }} />
            <div className={styles.timelineDate}>{format(d.day, 'd', { locale: es })}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────
export default function AnalyticsClient({ initialLeads }: { initialLeads: Lead[] }) {
  const [leads] = useState<Lead[]>(initialLeads)
  const [dateRange, setDateRange] = useState<DateRange>('mes')

  const scoped = useMemo(() => {
    const start = dateRangeStart(dateRange)
    if (!start) return leads
    return leads.filter(l => new Date(l.created_at) >= start)
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
    }
  }, [scoped])

  const byCanal = useMemo(() => makeBreakdown(scoped, l => l.canal_adquisicion), [scoped])
  const byPuesto = useMemo(() => makeBreakdown(scoped, l => l.puesto), [scoped])
  const byPlan = useMemo(() => makeBreakdown(scoped.filter(l => PIPELINE_CLOSED.includes(l.status)), l => l.plan), [scoped])

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
          <div className={styles.kpiMoney}><span>Pipeline total</span><strong>{fmtMoney(stats.pipeline)}</strong></div>
          <div className={styles.kpiMoney}><span>En cierre</span><strong style={{ color: '#a594ff' }}>{fmtMoney(stats.pipelineCierre)}</strong></div>
          <div className={styles.kpiMoney}><span>Cerrado</span><strong style={{ color: '#22d68a' }}>{fmtMoney(stats.pipelineCerrado)}</strong></div>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <h1>Analítica — {DATE_LABELS[dateRange]}</h1>
        </header>

        <div className={styles.body}>
          <FunnelChart leads={scoped} />
          <BreakdownTable title="Por canal" subtitle="Qué canales generan más pipeline" rows={byCanal} />
          <BreakdownTable title="Por decision maker (puesto)" subtitle="Qué roles convierten mejor" rows={byPuesto} />
          {byPlan.length > 0 && (
            <BreakdownTable title="Cerrados por plan" subtitle="Solo leads convertidos / recurrentes" rows={byPlan} />
          )}
          <DailyTimeline leads={scoped} range={dateRange} />
        </div>
      </main>
    </div>
  )
}
