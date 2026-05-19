'use client'

import { useMemo, useState, useEffect } from 'react'
import { type Lead } from '@/lib/supabase'
import { startOfDay, startOfWeek, startOfMonth, endOfMonth, subMonths, format, eachDayOfInterval } from 'date-fns'
import { es } from 'date-fns/locale'
import clsx from 'clsx'
import styles from './AnalyticsClient.module.css'
import { Sidebar } from './CommandCenter'
import {
  STATUS_LABELS, STATUS_PROJECTION_ORDER, PIPELINE_CLOSED, PIPELINE_CLOSING,
  DEFAULT_MONTO, statusColor, fmtMoney, fmtPct,
} from '@/lib/status'
import { phoneToState } from '@/lib/lada'
import { fmtPresupuesto } from '@/lib/budget'
import { forecastLeads, forecastByStage } from '@/lib/forecast'
import { agingByStage, cycleStats, agingBucket, AGING_COLOR } from '@/lib/velocity'
import { goalForPeriod, goalLabel } from '@/lib/goal'
import type { StagePassCount, TransitionStats } from '@/lib/statusHistory'

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
  const counts = STATUS_PROJECTION_ORDER.map(s => ({
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
function ForecastSection({ buckets, forecast, cerradoReal, goal, goalLabel }: {
  buckets: ReturnType<typeof forecastByStage>
  forecast: number
  cerradoReal: number
  goal: number
  goalLabel: string
}) {
  const max = buckets.length ? Math.max(...buckets.map(b => b.contribution)) : 0
  const goalPct = goal > 0 ? Math.min(100, (cerradoReal / goal) * 100) : 0
  const forecastPct = goal > 0 ? Math.min(100, (forecast / goal) * 100) : 0
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div style={{ flex: 1 }}>
          <h3>Proyección del periodo</h3>
          <span className={styles.sectionSubtitle}>
            Σ (monto × probabilidad de cierre por stage)
          </span>
        </div>
      </header>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 14, marginBottom: 16,
      }}>
        <div style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>Cerrado real</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800, color: '#22d68a', marginTop: 6 }}>{fmtMoney(cerradoReal)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>{goalLabel} {fmtMoney(goal)} · {goalPct.toFixed(0)}%</div>
        </div>
        <div style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>Forecast ponderado</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800, color: '#7c6af7', marginTop: 6 }}>{fmtMoney(forecast)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>vs meta · {forecastPct.toFixed(0)}%</div>
        </div>
        <div style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>Gap a meta</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800, color: cerradoReal >= goal ? '#22d68a' : '#f5c842', marginTop: 6 }}>
            {cerradoReal >= goal ? `+${fmtMoney(cerradoReal - goal)}` : `−${fmtMoney(goal - cerradoReal)}`}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>{cerradoReal >= goal ? 'meta superada' : 'faltan para meta'}</div>
        </div>
      </div>
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

// ─── Tactical suggestions ──────────────────────────────────────────────────
type Tactic = {
  emoji: string
  title: string
  body: React.ReactNode
  level: 'good' | 'neutral' | 'warn' | 'urgent'
}

function generateTactics(args: {
  goal: number
  forecast: number
  cerradoReal: number
  buckets: ReturnType<typeof forecastByStage>
  stageAging: ReturnType<typeof agingByStage>
  byCanal: BreakdownRow[]
  byPresupuesto: BreakdownRow[]
  rangeLabel: string
}): Tactic[] {
  const { goal, forecast, cerradoReal, buckets, stageAging, byCanal, byPresupuesto, rangeLabel } = args
  const tactics: Tactic[] = []

  // 1. Gap a meta
  const gap = goal - cerradoReal
  if (gap > 0) {
    tactics.push({
      emoji: '🎯',
      title: `Faltan ${fmtMoney(gap)} para la meta ${rangeLabel.toLowerCase()}`,
      body: forecast >= gap
        ? <>El forecast proyecta <strong>{fmtMoney(forecast)}</strong> — si los leads en pipeline cierran como esperás, llegás. Foco: confirmar las propuestas pendientes.</>
        : <>El forecast solo proyecta <strong>{fmtMoney(forecast)}</strong>. No te alcanza con lo que tenés. Generá pipeline nuevo o acelerá cierres en Propuesta/Espera.</>,
      level: forecast >= gap ? 'good' : 'urgent',
    })
  } else if (goal > 0) {
    tactics.push({
      emoji: '🏆',
      title: `Meta superada en ${fmtMoney(cerradoReal - goal)}`,
      body: <>Cerraste {fmtMoney(cerradoReal)} vs meta {fmtMoney(goal)}. Conservá el ritmo y empujá el pipeline activo para abrir el siguiente periodo arriba.</>,
      level: 'good',
    })
  }

  // 2. Cierres en Espera = palanca más rápida
  const espera = buckets.find(b => b.status === 'espera_aprobacion')
  if (gap > 0 && espera && espera.count > 0) {
    const avgTicket = espera.monto / espera.count
    const needed = Math.ceil(gap / avgTicket)
    if (needed <= espera.count) {
      tactics.push({
        emoji: '✅',
        title: `${needed} cierre${needed === 1 ? '' : 's'} en Espera te alcanza${needed === 1 ? '' : 'n'}`,
        body: <>Con ticket promedio de {fmtMoney(avgTicket)}, cerrar <strong>{needed} de los {espera.count}</strong> en Espera de aprobación cubre el gap. Es la palanca más corta — hablales hoy.</>,
        level: 'good',
      })
    } else {
      tactics.push({
        emoji: '⚡',
        title: `Espera no alcanza para llegar a meta`,
        body: <>Cerrando los {espera.count} de Espera generás {fmtMoney(espera.monto)}. Necesitás complementar con Propuestas o pipeline nuevo.</>,
        level: 'warn',
      })
    }
  }

  // 3. Stage que más aporta al forecast
  if (buckets.length > 0 && forecast > 0) {
    const top = [...buckets].sort((a, b) => b.contribution - a.contribution)[0]
    if (top && top.status !== 'convertido' && top.status !== 'cliente_recurrente') {
      const share = (top.contribution / forecast) * 100
      tactics.push({
        emoji: '🏗',
        title: `${STATUS_LABELS[top.status]} aporta ${share.toFixed(0)}% del forecast`,
        body: <>{top.count} leads, ticket promedio {fmtMoney(top.monto / top.count)}. Cada lead que avanzás de este stage al siguiente sube tu probabilidad de cierre del {Math.round(top.probability * 100)}% al siguiente nivel.</>,
        level: 'neutral',
      })
    }
  }

  // 4. Estancados >14 d — fuga
  const stalled = stageAging.filter(s => s.stuckCount >= 3).sort((a, b) => b.stuckCount - a.stuckCount)
  for (const s of stalled.slice(0, 2)) {
    tactics.push({
      emoji: '⚠️',
      title: `${s.stuckCount} estancados en ${s.label}`,
      body: <>Llevan más de 14 días sin moverse. Tomá la decisión hoy: avanzá si tiene aire o descartá. Cada día parado les baja la probabilidad real de cierre.</>,
      level: 'warn',
    })
  }

  // 5. Mejor canal
  if (byCanal.length >= 2) {
    const candidatos = byCanal.filter(c => c.leads >= 3 && c.cerrados > 0)
    const sorted = [...candidatos].sort((a, b) => (b.cerrados / b.leads) - (a.cerrados / a.leads))
    if (sorted.length) {
      const best = sorted[0]
      const rate = (best.cerrados / best.leads) * 100
      tactics.push({
        emoji: '🚀',
        title: `${best.key} convierte ${rate.toFixed(0)}%`,
        body: <>Tu mejor canal en conversion rate — {best.cerrados} cierres de {best.leads} leads, {fmtMoney(best.pipelineCerrado)} cerrado. Si podés mover presupuesto de paid o esfuerzo de outreach, este es el lugar.</>,
        level: 'good',
      })
    }
  }

  // 6. Mejor tier de presupuesto
  if (byPresupuesto.length >= 2) {
    const candidatos = byPresupuesto.filter(c => c.leads >= 3 && c.cerrados > 0 && c.key !== '— sin dato —')
    const sorted = [...candidatos].sort((a, b) => (b.cerrados / b.leads) - (a.cerrados / a.leads))
    if (sorted.length) {
      const best = sorted[0]
      const rate = (best.cerrados / best.leads) * 100
      tactics.push({
        emoji: '💰',
        title: `Presupuesto "${best.key}" convierte ${rate.toFixed(0)}%`,
        body: <>Es el tier que mejor cierra. Calificá leads por presupuesto temprano en el outreach — vale más responder rápido a un "{best.key}" que a un lead sin info.</>,
        level: 'good',
      })
    }
  }

  return tactics
}

const TACTIC_COLOR: Record<Tactic['level'], string> = {
  good:    '#22d68a',
  neutral: '#7c6af7',
  warn:    '#f5c842',
  urgent:  '#f05a5a',
}

function TacticsSection({ tactics }: { tactics: Tactic[] }) {
  if (tactics.length === 0) return null
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Sugerencias tácticas</h3>
          <span className={styles.sectionSubtitle}>
            Recomendaciones calculadas a partir del pipeline, velocity y canales del periodo seleccionado.
          </span>
        </div>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {tactics.map((t, i) => (
          <div key={i}
            style={{
              background: 'var(--glass)',
              border: '1px solid var(--border)',
              borderLeft: `3px solid ${TACTIC_COLOR[t.level]}`,
              borderRadius: 12,
              padding: '14px 16px',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 18 }}>{t.emoji}</span>
              <strong style={{ fontSize: 13.5, color: 'var(--text)' }}>{t.title}</strong>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.5 }}>{t.body}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── Movement section (status history) ────────────────────────────────────
function MovementSection({ data }: { data: MovementData | null }) {
  if (data === null) {
    return (
      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h3>Movimiento del funnel</h3>
          <span className={styles.sectionSubtitle}>Cargando histórico de cambios…</span>
        </header>
      </section>
    )
  }

  const passMax = data.passCounts.length ? Math.max(...data.passCounts.map(p => p.unique_leads)) : 0
  const visibleTransitions = data.transitions.slice(0, 12)

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Movimiento del funnel</h3>
          <span className={styles.sectionSubtitle}>
            Cuántos leads tocaron cada stage en el periodo, y el tiempo que tardan
            en pasar de un stage al siguiente. Reconstruido del histórico real.
          </span>
        </div>
      </header>
      {data.passCounts.length === 0
        ? <div className={styles.empty}>Sin cambios de status registrados en este rango.</div>
        : (
          <>
            <div style={{ marginBottom: 18 }}>
              <h4 style={{ margin: '0 0 10px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text3)', fontWeight: 700 }}>
                Leads que pasaron por cada stage
              </h4>
              <table className={styles.breakdownTable}>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Leads únicos</th>
                    <th>Total de transiciones</th>
                  </tr>
                </thead>
                <tbody>
                  {data.passCounts.map(p => (
                    <tr key={p.status}>
                      <td className={styles.breakdownKey}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 999, background: statusColor(p.status) }} />
                          <span>{p.label}</span>
                        </div>
                        <Bar value={p.unique_leads} max={passMax} color={statusColor(p.status)} />
                      </td>
                      <td><strong>{p.unique_leads}</strong></td>
                      <td>{p.changes}{p.changes > p.unique_leads && <span style={{ color: 'var(--text3)', fontSize: 11 }}> (rebotes)</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {visibleTransitions.length > 0 && (
              <div>
                <h4 style={{ margin: '0 0 10px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text3)', fontWeight: 700 }}>
                  Tiempo entre stages
                </h4>
                <table className={styles.breakdownTable}>
                  <thead>
                    <tr>
                      <th>Transición</th>
                      <th>Veces</th>
                      <th>Mediana (días)</th>
                      <th>Promedio (días)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTransitions.map(t => (
                      <tr key={`${t.from}-${t.to}`}>
                        <td className={styles.breakdownKey}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(t.from) }} />
                            <span style={{ color: 'var(--text2)' }}>{STATUS_LABELS[t.from]}</span>
                            <span style={{ color: 'var(--text3)' }}>→</span>
                            <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(t.to) }} />
                            <span>{STATUS_LABELS[t.to]}</span>
                          </div>
                        </td>
                        <td>{t.count}</td>
                        <td><strong>{t.medianDays.toFixed(1)}</strong></td>
                        <td>{t.avgDays.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
    </section>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────
type MovementData = {
  passCounts: StagePassCount[]
  transitions: TransitionStats[]
  sample_size: number
}

export default function AnalyticsClient({ initialLeads }: { initialLeads: Lead[] }) {
  const [leads] = useState<Lead[]>(initialLeads)
  const [movement, setMovement] = useState<MovementData | null>(null)
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

  const periodGoal = goalForPeriod(dateRange)
  const periodGoalLabel = goalLabel(dateRange)

  // Fetch movement data when range changes
  useEffect(() => {
    const { from, to } = dateRangeBounds(dateRange)
    const qs = new URLSearchParams()
    if (from) qs.set('from', from.toISOString())
    if (to)   qs.set('to', to.toISOString())
    let cancelled = false
    setMovement(null)
    fetch(`/api/analytics/movement?${qs}`, { cache: 'no-store' })
      .then(r => r.json())
      .then((j: MovementData) => { if (!cancelled) setMovement(j) })
      .catch(() => { if (!cancelled) setMovement({ passCounts: [], transitions: [], sample_size: 0 }) })
    return () => { cancelled = true }
  }, [dateRange])

  const tactics = useMemo(() => generateTactics({
    goal: periodGoal,
    forecast: stats.forecast,
    cerradoReal: stats.pipelineCerrado,
    buckets: forecastBuckets,
    stageAging,
    byCanal,
    byPresupuesto,
    rangeLabel: DATE_LABELS[dateRange],
  }), [periodGoal, stats.forecast, stats.pipelineCerrado, forecastBuckets, stageAging, byCanal, byPresupuesto, dateRange])

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
          <ForecastSection buckets={forecastBuckets} forecast={stats.forecast} cerradoReal={stats.pipelineCerrado} goal={periodGoal} goalLabel={periodGoalLabel} />
          <TacticsSection tactics={tactics} />
          <FunnelChart leads={scoped} />
          <MovementSection data={movement} />
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
