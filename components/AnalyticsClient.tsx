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
import type { StagePassCount, TransitionStats, ForwardAdvance } from '@/lib/statusHistory'

// Estilos compartidos para tablas inline
const thLeft: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text3)' }
const thRight: React.CSSProperties = { textAlign: 'right', padding: '8px 10px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text3)' }
const tdLeft: React.CSSProperties = { textAlign: 'left', padding: '10px 10px', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }
const tdRight: React.CSSProperties = { textAlign: 'right', padding: '10px 10px', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }

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
function FunnelChart({ leads, cycle }: { leads: Lead[]; cycle?: ReturnType<typeof cycleStats> }) {
  const counts = STATUS_PROJECTION_ORDER.map(s => ({
    s, label: STATUS_LABELS[s], count: leads.filter(l => l.status === s).length,
    monto: sumMonto(leads.filter(l => l.status === s)),
  }))
  const max = Math.max(...counts.map(c => c.count), 1)
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Funnel por status</h3>
          <span className={styles.sectionSubtitle}>
            Estado actual de los leads en el rango
            {cycle && cycle.count > 0 && (
              <> · Ciclo Nuevo→Cerrado: <strong>{cycle.medianDays.toFixed(0)} días</strong> (mediana, {cycle.count} cerrados)</>
            )}
          </span>
        </div>
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
function ForecastSection({ buckets, forecast, cerradoReal, goal, goalLabel, convRate, totalLeads }: {
  buckets: ReturnType<typeof forecastByStage>
  forecast: number
  cerradoReal: number
  goal: number
  goalLabel: string
  convRate: number
  totalLeads: number
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
        <div style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 18px' }}
          title="Convertidos / leads no descartados. Mide la CALIDAD del funnel, no el volumen.">
          <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>Conv. rate</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800, color: '#f5c842', marginTop: 6 }}>
            {fmtPct(convRate)}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>de {totalLeads} leads</div>
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

// ─── Funnel health (movimiento + velocidad unificados) ───────────────────
function FunnelHealthSection({ aging, cycle, movement }: {
  aging: ReturnType<typeof agingByStage>
  cycle: ReturnType<typeof cycleStats>
  movement: MovementData | null
}) {
  // Indexar pasaron-por-stage y tiempo-para-avanzar por status
  const passBy = new Map<Lead['status'], number>()
  if (movement) {
    for (const p of movement.passCounts) passBy.set(p.status, p.unique_leads)
  }
  const advanceBy = movement?.advance || {}

  // Mostrar solo stages con actividad relevante en el periodo
  const rows = aging.filter(a => a.count > 0 || (passBy.get(a.status) || 0) > 0)

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Funnel — movimiento y velocidad</h3>
          <span className={styles.sectionSubtitle}>
            Cuántos leads pasaron por cada stage en el periodo, cuántos siguen ahí y cuánto tardan en avanzar.{' '}
            {cycle.count > 0
              ? <>Ciclo Nuevo→Cerrado: mediana <strong>{cycle.medianDays.toFixed(0)} días</strong> ({cycle.count} cerrados).</>
              : <>Aún no hay cierres en el rango para medir el ciclo completo.</>}
          </span>
        </div>
      </header>
      {rows.length === 0
        ? <div className={styles.empty}>Sin actividad en este rango.</div>
        : (
          <table className={styles.breakdownTable}>
            <thead>
              <tr>
                <th>Stage</th>
                <th title="Leads únicos que tocaron este stage durante el periodo">Pasaron</th>
                <th title="Leads que están en este stage ahora mismo">Ahora</th>
                <th title="Días que llevan los leads que están aquí (mediana)">Días aquí</th>
                <th title="Tiempo que tardaron en pasar al siguiente stage del funnel (mediana). Excluye retrocesos y stages laterales como Descartado.">→ avanzar</th>
                <th title="Leads que llevan más de 14 días en el stage sin avanzar">Estancados</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const ab = agingBucket(r.medianDays)
                const pass = passBy.get(r.status) || 0
                const adv = advanceBy[r.status]
                return (
                  <tr key={r.status}>
                    <td className={styles.breakdownKey}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: statusColor(r.status) }} />
                        <span>{r.label}</span>
                      </div>
                    </td>
                    <td><strong>{pass || '—'}</strong></td>
                    <td>{r.count > 0 ? r.count : '—'}</td>
                    <td>
                      {r.count > 0
                        ? <strong style={{ color: AGING_COLOR[ab] }}>{r.medianDays.toFixed(1)} d</strong>
                        : '—'}
                    </td>
                    <td>
                      {adv
                        ? <span><strong>{adv.medianDays.toFixed(1)} d</strong> <span style={{ color: 'var(--text3)', fontSize: 11 }}>(n={adv.count})</span></span>
                        : '—'}
                    </td>
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

// ─── Quién convierte (canal, presupuesto, vacante) ──────────────────────
function ConvertersSection({ byCanal, byPresupuesto, byVacante }: {
  byCanal: BreakdownRow[]
  byPresupuesto: BreakdownRow[]
  byVacante: BreakdownRow[]
}) {
  const cards: Array<{ title: string; subtitle: string; rows: BreakdownRow[] }> = [
    { title: 'Por canal', subtitle: 'De dónde vienen los que cierran', rows: byCanal },
    { title: 'Por presupuesto', subtitle: 'Qué tier de inversión convierte', rows: byPresupuesto },
    { title: 'Por vacante', subtitle: 'Qué puestos cierran más rápido', rows: byVacante },
  ]
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>¿Quién convierte?</h3>
          <span className={styles.sectionSubtitle}>
            Top 3 por conversion rate y por revenue cerrado. Conv rate filtra a segmentos con ≥3 leads para evitar ruido.
          </span>
        </div>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        {cards.map(c => <ConverterCard key={c.title} title={c.title} subtitle={c.subtitle} rows={c.rows} />)}
      </div>
    </section>
  )
}

function ConverterCard({ title, subtitle, rows }: { title: string; subtitle: string; rows: BreakdownRow[] }) {
  const byConvRate = [...rows]
    .filter(r => r.leads >= 3 && r.key !== '— sin dato —')
    .map(r => ({ ...r, rate: r.leads > 0 ? r.cerrados / r.leads : 0 }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 3)
  const byRevenue = [...rows]
    .filter(r => r.pipelineCerrado > 0 && r.key !== '— sin dato —')
    .sort((a, b) => b.pipelineCerrado - a.pipelineCerrado)
    .slice(0, 3)
  const maxRate = byConvRate[0]?.rate || 0
  const maxRev = byRevenue[0]?.pipelineCerrado || 0

  return (
    <div style={{
      background: 'var(--glass)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '14px 16px',
    }}>
      <div style={{ marginBottom: 10 }}>
        <strong style={{ fontSize: 13.5, color: 'var(--text)' }}>{title}</strong>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{subtitle}</div>
      </div>

      {/* Por conv rate */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 6 }}>
          Top conv. rate
        </div>
        {byConvRate.length === 0
          ? <div style={{ fontSize: 11.5, color: 'var(--text3)', fontStyle: 'italic' }}>Sin datos suficientes (n≥3)</div>
          : byConvRate.map(r => (
              <div key={r.key} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{r.key}</span>
                  <span style={{ color: '#22d68a', fontFamily: 'var(--font-display)', fontWeight: 700 }}>
                    {(r.rate * 100).toFixed(0)}% <span style={{ color: 'var(--text3)', fontSize: 10, fontWeight: 400 }}>({r.cerrados}/{r.leads})</span>
                  </span>
                </div>
                <Bar value={r.rate} max={maxRate} color="#22d68a" />
              </div>
            ))}
      </div>

      {/* Por revenue */}
      <div>
        <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 6 }}>
          Top revenue cerrado
        </div>
        {byRevenue.length === 0
          ? <div style={{ fontSize: 11.5, color: 'var(--text3)', fontStyle: 'italic' }}>Aún no hay cierres en este rango</div>
          : byRevenue.map(r => (
              <div key={r.key} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{r.key}</span>
                  <span style={{ color: '#7c6af7', fontFamily: 'var(--font-display)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtMoney(r.pipelineCerrado)}
                  </span>
                </div>
                <Bar value={r.pipelineCerrado} max={maxRev} color="#7c6af7" />
              </div>
            ))}
      </div>
    </div>
  )
}

// ─── Notas por status (análisis cualitativo) ─────────────────────────────
function NotasSection({ leads }: { leads: Lead[] }) {
  const [expanded, setExpanded] = useState<Lead['status'] | null>('descartado')

  // Agrupar leads CON nota por status. Solo stages con al menos una nota.
  const grouped = useMemo(() => {
    const map = new Map<Lead['status'], Lead[]>()
    for (const l of leads) {
      if (!l.notas || !l.notas.trim()) continue
      const arr = map.get(l.status) || []
      arr.push(l)
      map.set(l.status, arr)
    }
    return STATUS_PROJECTION_ORDER
      .filter(s => map.has(s))
      .map(s => ({ status: s, label: STATUS_LABELS[s], leads: map.get(s)! }))
  }, [leads])

  if (grouped.length === 0) return null

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Notas por status</h3>
          <span className={styles.sectionSubtitle}>
            Análisis cualitativo. Útil sobre todo para Descartado — entendé por qué cae un lead, no solo cuántos.
          </span>
        </div>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {grouped.map(g => {
          const isOpen = expanded === g.status
          return (
            <div key={g.status}
              style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <button onClick={() => setExpanded(isOpen ? null : g.status)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', background: 'transparent', border: 'none', color: 'var(--text)',
                  padding: '12px 16px', cursor: 'pointer', fontFamily: 'var(--font)',
                }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: statusColor(g.status) }} />
                  <strong style={{ fontSize: 13.5 }}>{g.label}</strong>
                  <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>· {g.leads.length} con notas</span>
                </span>
                <span style={{ color: 'var(--text3)', fontSize: 11 }}>{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  {g.leads.map(l => (
                    <div key={l.id}
                      style={{
                        padding: '10px 16px',
                        borderBottom: '1px solid var(--border)',
                        display: 'flex', flexDirection: 'column', gap: 4,
                      }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                        <strong style={{ fontSize: 13, color: 'var(--text)' }}>
                          {l.nombre || l.empresa || l.email}
                        </strong>
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {l.email}</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.5, fontStyle: 'italic' }}>
                        "{l.notas}"
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── Donut chart de fuentes de leads ────────────────────────────────────
const DONUT_PALETTE = ['#22d68a', '#4ea8f5', '#a594ff', '#f05a5a', '#f5c842', '#7c6af7', '#00c8a0', '#f5914e', '#3a4ea8']

function SourcesDonut({ leads }: { leads: Lead[] }) {
  const buckets = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of leads) {
      const k = l.canal_adquisicion || 'Sin canal'
      m.set(k, (m.get(k) || 0) + 1)
    }
    const all = Array.from(m.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
    const TOP = 6
    if (all.length <= TOP) return all
    const top = all.slice(0, TOP)
    const otros = all.slice(TOP).reduce((s, x) => s + x.count, 0)
    return [...top, { key: 'Otros', count: otros }]
  }, [leads])

  const total = buckets.reduce((s, b) => s + b.count, 0)
  const R = 70, STROKE = 22, CX = 90, CY = 90
  const CIRC = 2 * Math.PI * R

  let acc = 0
  const arcs = buckets.map((b, i) => {
    const pct = total > 0 ? b.count / total : 0
    const dash = pct * CIRC
    const offset = -acc * CIRC
    acc += pct
    return { ...b, color: DONUT_PALETTE[i % DONUT_PALETTE.length], dash, offset, pct }
  })

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Fuentes de leads</h3>
          <span className={styles.sectionSubtitle}>Distribución por canal de adquisición</span>
        </div>
      </header>
      {total === 0
        ? <div className={styles.empty}>Sin leads en este rango.</div>
        : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: 180, height: 180, flexShrink: 0 }}>
              <svg width="180" height="180" viewBox="0 0 180 180" style={{ transform: 'rotate(-90deg)' }}>
                <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
                {arcs.map((a, i) => (
                  <circle key={i} cx={CX} cy={CY} r={R} fill="none"
                    stroke={a.color} strokeWidth={STROKE}
                    strokeDasharray={`${a.dash} ${CIRC}`}
                    strokeDashoffset={a.offset} />
                ))}
              </svg>
              <div style={{
                position: 'absolute', inset: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
              }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color: 'var(--text)', lineHeight: 1 }}>{total}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2 }}>Leads</div>
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {arcs.map((a, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 0', borderBottom: i < arcs.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: a.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.key}</span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text3)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                    {(a.pct * 100).toFixed(0)}% <span style={{ color: 'var(--text3)', fontSize: 11 }}>({a.count})</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
    </section>
  )
}

// ─── Ventas cerradas + conversión por semana del periodo ────────────────
function WeeklyConversionChart({ leads, range }: { leads: Lead[]; range: DateRange }) {
  const data = useMemo(() => {
    const { from, to } = dateRangeBounds(range)
    if (!from) {
      // 'Todo el tiempo' — agrupar por mes en lugar de semana
      const m = new Map<string, { closed: Lead[]; total: Lead[] }>()
      for (const l of leads) {
        const d = new Date(l.created_at)
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        const entry = m.get(key) || { closed: [], total: [] }
        entry.total.push(l)
        if (PIPELINE_CLOSED.includes(l.status)) entry.closed.push(l)
        m.set(key, entry)
      }
      return Array.from(m.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-8)  // últimos 8 meses
        .map(([key, v]) => ({
          label: new Date(key + '-01').toLocaleDateString('es-MX', { month: 'short' }),
          closed: v.closed.length,
          total: v.total.length,
          revenue: v.closed.reduce((s, l) => s + (l.monto ?? DEFAULT_MONTO), 0),
          convRate: v.total.length > 0 ? v.closed.length / v.total.length : 0,
        }))
    }
    // Por SEMANA del periodo (lunes a domingo)
    const end = to || new Date()
    const weeks: Array<{ label: string; start: Date; end: Date }> = []
    const cur = new Date(from)
    // Alinear al lunes
    const day = cur.getDay()
    const diff = day === 0 ? -6 : 1 - day
    cur.setDate(cur.getDate() + diff)
    while (cur <= end) {
      const wStart = new Date(cur)
      const wEnd = new Date(cur); wEnd.setDate(wEnd.getDate() + 6); wEnd.setHours(23, 59, 59)
      weeks.push({
        label: `${wStart.getDate()} ${wStart.toLocaleDateString('es-MX', { month: 'short' })}`,
        start: wStart, end: wEnd,
      })
      cur.setDate(cur.getDate() + 7)
    }
    return weeks.map(w => {
      const weekLeads = leads.filter(l => {
        const t = new Date(l.created_at).getTime()
        return t >= w.start.getTime() && t <= w.end.getTime()
      })
      const closed = weekLeads.filter(l => PIPELINE_CLOSED.includes(l.status))
      return {
        label: w.label,
        closed: closed.length,
        total: weekLeads.length,
        revenue: closed.reduce((s, l) => s + (l.monto ?? DEFAULT_MONTO), 0),
        convRate: weekLeads.length > 0 ? closed.length / weekLeads.length : 0,
      }
    })
  }, [leads, range])

  const maxRevenue = Math.max(...data.map(d => d.revenue), 1)

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <h3>Ventas cerradas y conversión</h3>
          <span className={styles.sectionSubtitle}>
            {range === 'todo' ? 'Últimos 8 meses' : 'Por semana del periodo'}
          </span>
        </div>
      </header>
      {data.length === 0
        ? <div className={styles.empty}>Sin datos en este rango.</div>
        : (
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 180, padding: '0 4px', borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
              {data.map((d, i) => {
                const h = maxRevenue > 0 ? (d.revenue / maxRevenue) * 100 : 0
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', minWidth: 0 }}
                    title={`${d.label}: ${d.closed} cerrados · ${fmtMoney(d.revenue)} · ${(d.convRate * 100).toFixed(0)}% conv`}>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4, fontVariantNumeric: 'tabular-nums' }}>
                      {d.closed > 0 ? d.closed : ''}
                    </div>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                      <div style={{
                        width: '100%', maxWidth: 32, margin: '0 auto',
                        height: d.revenue === 0 ? 4 : `${Math.max(h, 6)}%`,
                        background: 'linear-gradient(180deg, #22d68a 0%, #00c8a0 100%)',
                        borderRadius: '4px 4px 0 0',
                        opacity: d.revenue === 0 ? 0.25 : 1,
                      }} />
                    </div>
                  </div>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '0 4px' }}>
              {data.map((d, i) => (
                <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {d.label}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '4px 4px 0', borderTop: '1px solid var(--border)', marginTop: 8 }}>
              {data.map((d, i) => (
                <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 10.5, fontFamily: 'var(--mono)', color: d.convRate > 0 ? '#22d68a' : 'var(--text3)', fontVariantNumeric: 'tabular-nums' }}>
                  {d.convRate > 0 ? `${(d.convRate * 100).toFixed(0)}%` : '—'}
                </div>
              ))}
            </div>
          </div>
        )}
    </section>
  )
}

// ─── Separador entre grupos temáticos (estilo CRO dashboard) ────────────
function GroupHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{
      marginTop: 8, marginBottom: -6,
      paddingBottom: 8,
      borderBottom: '1px solid var(--border)',
    }}>
      <h2 style={{
        margin: 0, fontFamily: 'var(--font-display)',
        fontSize: 20, fontWeight: 800, color: 'var(--text)',
        letterSpacing: '-0.015em',
      }}>{title}</h2>
      {subtitle && (
        <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 4 }}>
          {subtitle}
        </div>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════
// REDISEÑO BI DASHBOARD — componentes nuevos
// ═════════════════════════════════════════════════════════════════════════

// ─── KPI Card limpia (sin gradiente, label uppercase, número grande) ─────
function KPICard({ label, value, sub, accentColor }: {
  label: string
  value: string
  sub?: string
  accentColor?: string
}) {
  return (
    <div style={{
      background: 'var(--glass)',
      border: '1px solid var(--border)',
      borderRadius: 14,
      padding: '18px 20px',
      display: 'flex', flexDirection: 'column', gap: 4,
      minWidth: 0,
    }}>
      <div style={{
        fontSize: 10.5, color: 'var(--text3)',
        textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700,
      }}>{label}</div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 'clamp(20px, 2vw, 30px)',
        fontWeight: 800,
        color: accentColor || 'var(--text)',
        letterSpacing: '-0.025em',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.1,
        marginTop: 4,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip',
      }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  )
}

// ─── Tabs Table — tabla con tabs (canal/vacante/presupuesto/ciudad) ─────
type TabKey = 'canal' | 'vacante' | 'presupuesto' | 'ciudad'
const TAB_LABELS: Record<TabKey, string> = {
  canal: 'Por canal',
  vacante: 'Por vacante',
  presupuesto: 'Por presupuesto',
  ciudad: 'Por ciudad',
}

function TabsTable({ byCanal, byVacante, byPresupuesto, byEstado, avgConvRate }: {
  byCanal: BreakdownRow[]
  byVacante: BreakdownRow[]
  byPresupuesto: BreakdownRow[]
  byEstado: BreakdownRow[]
  avgConvRate: number
}) {
  const [tab, setTab] = useState<TabKey>('canal')
  const rowsByTab: Record<TabKey, BreakdownRow[]> = {
    canal: byCanal, vacante: byVacante, presupuesto: byPresupuesto, ciudad: byEstado,
  }
  const rows = rowsByTab[tab]
    .filter(r => r.key !== '— sin dato —')
    .map(r => ({ ...r, convRate: r.leads > 0 ? r.cerrados / r.leads : 0 }))
    .sort((a, b) => b.convRate - a.convRate)

  // Color del % según comparación con promedio
  const colorForConv = (rate: number) => {
    if (rate > avgConvRate * 1.1) return '#22d68a'  // mejor que el promedio
    if (rate < avgConvRate * 0.6) return '#f05a5a'  // bajo
    return '#f5c842'  // promedio
  }

  return (
    <section className={styles.section}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 14, paddingBottom: 0 }}>
        {(Object.keys(TAB_LABELS) as TabKey[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              background: 'transparent', border: 'none',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--text)' : 'var(--text3)',
              padding: '10px 14px', cursor: 'pointer',
              fontFamily: 'var(--font)', fontSize: 13, fontWeight: 500,
              marginBottom: -1,
            }}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
            Rendimiento {TAB_LABELS[tab].toLowerCase()}
          </h3>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            Ordenado por conv. rate · Promedio {fmtPct(avgConvRate)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text3)' }}>
          <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: '#22d68a', marginRight: 4 }} />Mejor</span>
          <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: '#f5c842', marginRight: 4 }} />Promedio</span>
          <span><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: '#f05a5a', marginRight: 4 }} />Bajo</span>
        </div>
      </div>

      {rows.length === 0
        ? <div className={styles.empty}>Sin datos en este rango.</div>
        : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ ...thLeft, width: 36 }}>#</th>
                <th style={thLeft}>{TAB_LABELS[tab].replace('Por ', '').charAt(0).toUpperCase() + TAB_LABELS[tab].replace('Por ', '').slice(1)}</th>
                <th style={thRight}>Leads</th>
                <th style={thRight}>Conv. %</th>
                <th style={thRight}>Cerrados</th>
                <th style={thRight}>Revenue</th>
                <th style={thRight}>Rev/lead</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const color = colorForConv(r.convRate)
                const revPerLead = r.leads > 0 ? r.pipelineCerrado / r.leads : 0
                return (
                  <tr key={r.key} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={tdLeft}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22, borderRadius: 6,
                        background: color + '22', color: color,
                        fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 11,
                      }}>{i + 1}</span>
                    </td>
                    <td style={{ ...tdLeft, fontWeight: 500 }}>{r.key}</td>
                    <td style={tdRight}>{r.leads}</td>
                    <td style={{ ...tdRight }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                        <span style={{ color, fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14 }}>
                          {(r.convRate * 100).toFixed(0)}%
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                          {r.cerrados}/{r.leads}
                        </span>
                      </div>
                    </td>
                    <td style={tdRight}>{r.cerrados}</td>
                    <td style={tdRight}>{fmtMoney(r.pipelineCerrado)}</td>
                    <td style={tdRight}>{fmtMoney(revPerLead)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
    </section>
  )
}

// ─── Insights clave (sidebar derecho con cards accionables one-liner) ────
type Insight = { emoji: string; title: React.ReactNode; sub?: string; level: 'good' | 'warn' | 'neutral' }
function buildInsights({ byCanal, byPresupuesto, avgConvRate, totalLeads }: {
  byCanal: BreakdownRow[]
  byPresupuesto: BreakdownRow[]
  avgConvRate: number
  totalLeads: number
}): Insight[] {
  const out: Insight[] = []
  const canalesElegibles = byCanal.filter(c => c.leads >= 5 && c.key !== '— sin dato —' && c.cerrados > 0)
  const bestCanal = [...canalesElegibles].sort((a, b) => (b.cerrados/b.leads) - (a.cerrados/a.leads))[0]
  if (bestCanal && avgConvRate > 0) {
    const rate = bestCanal.cerrados / bestCanal.leads
    const factor = rate / avgConvRate
    if (factor >= 1.3) {
      out.push({
        emoji: '📈',
        title: <><strong>{bestCanal.key}</strong> convierte <strong>{factor.toFixed(1)}x</strong> mejor que el promedio</>,
        sub: `${(rate * 100).toFixed(0)}% vs ${(avgConvRate * 100).toFixed(0)}% de conversión promedio`,
        level: 'good',
      })
    }
  }
  // Revenue por lead — mejor canal
  const avgRevPerLead = canalesElegibles.length > 0
    ? canalesElegibles.reduce((s, c) => s + c.pipelineCerrado, 0) / canalesElegibles.reduce((s, c) => s + c.leads, 0)
    : 0
  const bestRev = [...canalesElegibles].sort((a, b) => (b.pipelineCerrado/b.leads) - (a.pipelineCerrado/a.leads))[0]
  if (bestRev && avgRevPerLead > 0) {
    const rpl = bestRev.pipelineCerrado / bestRev.leads
    const factor = rpl / avgRevPerLead
    if (factor >= 1.5) {
      out.push({
        emoji: '💰',
        title: <><strong>{bestRev.key}</strong> genera <strong>{factor.toFixed(1)}x</strong> más revenue por lead</>,
        sub: `${fmtMoney(rpl)} vs ${fmtMoney(avgRevPerLead)} promedio por lead`,
        level: 'good',
      })
    }
  }
  // Muestra insuficiente
  const lowSample = byCanal.filter(c => c.leads >= 1 && c.leads < 5 && c.cerrados > 0 && c.cerrados / c.leads >= 0.5)
  if (lowSample[0]) {
    const c = lowSample[0]
    out.push({
      emoji: '⚠️',
      title: <><strong>{c.key}</strong> tiene {(c.cerrados/c.leads*100).toFixed(0)}% de conversión</>,
      sub: `Pero solo ${c.leads} lead${c.leads === 1 ? '' : 's'}. Muestra insuficiente`,
      level: 'warn',
    })
  }
  // Canal con conv baja
  const lowConv = canalesElegibles.filter(c => avgConvRate > 0 && (c.cerrados/c.leads) < avgConvRate * 0.5)
  if (lowConv.length > 0) {
    const names = lowConv.slice(0, 2).map(c => c.key).join(' y ')
    out.push({
      emoji: '📉',
      title: <><strong>{names}</strong> tienen baja conversión</>,
      sub: 'Considera optimizar o pausar inversión',
      level: 'warn',
    })
  }
  // Mejor tier de presupuesto
  const bestPres = [...byPresupuesto.filter(p => p.leads >= 3 && p.key !== '— sin dato —' && p.cerrados > 0)]
    .sort((a, b) => (b.cerrados/b.leads) - (a.cerrados/a.leads))[0]
  if (bestPres) {
    const rate = bestPres.cerrados / bestPres.leads
    out.push({
      emoji: '🎯',
      title: <>Presupuesto <strong>{bestPres.key}</strong> convierte al {(rate * 100).toFixed(0)}%</>,
      sub: 'Calificá leads por presupuesto temprano',
      level: 'neutral',
    })
  }
  return out.slice(0, 4)
}

function InsightsSidebar({ insights }: { insights: Insight[] }) {
  const colors = { good: '#22d68a', warn: '#f5c842', neutral: '#7c6af7' }
  return (
    <div style={{
      background: 'var(--glass)', border: '1px solid var(--border)',
      borderRadius: 14, padding: '18px 16px',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 14 }}>✨</span>
        <strong style={{ fontSize: 13.5, color: 'var(--text)' }}>Insights clave</strong>
      </div>
      {insights.length === 0
        ? <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>Sin insights suficientes en este rango.</div>
        : insights.map((ins, i) => (
            <div key={i} style={{
              background: 'var(--glass)',
              border: '1px solid var(--border)',
              borderLeft: `3px solid ${colors[ins.level]}`,
              borderRadius: 10,
              padding: '10px 12px',
            }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>{ins.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.4 }}>{ins.title}</div>
                  {ins.sub && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{ins.sub}</div>}
                </div>
              </div>
            </div>
          ))}
    </div>
  )
}

// ─── Bottom row cards ────────────────────────────────────────────────────
function EficienciaPorCanal({ byCanal }: { byCanal: BreakdownRow[] }) {
  const rows = byCanal
    .filter(c => c.key !== '— sin dato —' && c.leads >= 3)
    .map(c => ({ ...c, revPerLead: c.leads > 0 ? c.pipelineCerrado / c.leads : 0 }))
    .sort((a, b) => b.revPerLead - a.revPerLead)
    .slice(0, 6)
  const max = rows[0]?.revPerLead || 1
  return (
    <div style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px' }}>
      <h3 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>Eficiencia por canal</h3>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 14 }}>Revenue generado por cada lead</div>
      {rows.length === 0
        ? <div style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>Sin datos suficientes (n≥3)</div>
        : rows.map(r => (
            <div key={r.key} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, marginBottom: 3 }}>
                <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{r.key}</span>
                <span style={{ color: '#22d68a', fontFamily: 'var(--font-display)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtMoney(r.revPerLead)}
                </span>
              </div>
              <div style={{ height: 5, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(r.revPerLead / max) * 100}%`, background: 'linear-gradient(90deg, #22d68a, #00c8a0)', borderRadius: 3 }} />
              </div>
            </div>
          ))}
    </div>
  )
}

function DistribucionConversiones({ leads }: { leads: Lead[] }) {
  const cerrados = leads.filter(l => PIPELINE_CLOSED.includes(l.status))
  const enProceso = leads.filter(l => !PIPELINE_CLOSED.includes(l.status) && l.status !== 'descartado')
  const abandonados = leads.filter(l => l.status === 'descartado')
  const total = leads.length
  const segments = [
    { label: 'Cerrados', value: cerrados.length, color: '#22d68a' },
    { label: 'En proceso', value: enProceso.length, color: '#4ea8f5' },
    { label: 'Abandonados', value: abandonados.length, color: '#a594ff' },
  ]
  const R = 56, STROKE = 18, CX = 75, CY = 75, CIRC = 2 * Math.PI * R
  let acc = 0
  const arcs = segments.map(s => {
    const pct = total > 0 ? s.value / total : 0
    const dash = pct * CIRC
    const offset = -acc * CIRC
    acc += pct
    return { ...s, pct, dash, offset }
  })
  return (
    <div style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px' }}>
      <h3 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>Distribución de conversiones</h3>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 14 }}>Del total de leads</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <div style={{ position: 'relative', width: 150, height: 150, flexShrink: 0 }}>
          <svg width="150" height="150" viewBox="0 0 150 150" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
            {arcs.map((a, i) => (
              <circle key={i} cx={CX} cy={CY} r={R} fill="none"
                stroke={a.color} strokeWidth={STROKE}
                strokeDasharray={`${a.dash} ${CIRC}`}
                strokeDashoffset={a.offset} />
            ))}
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 800, color: 'var(--text)', lineHeight: 1 }}>{total}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>Leads</div>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          {arcs.map(a => (
            <div key={a.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: a.color }} />
                <span style={{ fontSize: 12, color: 'var(--text)' }}>{a.label}</span>
              </div>
              <span style={{ fontSize: 11.5, color: 'var(--text3)', fontVariantNumeric: 'tabular-nums' }}>
                {a.value} <span style={{ color: 'var(--text3)' }}>({(a.pct * 100).toFixed(1)}%)</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function VolumenConfianza({ byCanal }: { byCanal: BreakdownRow[] }) {
  const tiers = byCanal
    .filter(c => c.key !== '— sin dato —')
    .reduce((acc, c) => {
      if (c.leads >= 30) acc.high.push(c)
      else if (c.leads >= 10) acc.mid.push(c)
      else acc.low.push(c)
      return acc
    }, { high: [] as BreakdownRow[], mid: [] as BreakdownRow[], low: [] as BreakdownRow[] })
  return (
    <div style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px' }}>
      <h3 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>Conversión por volumen <span style={{ color: 'var(--text3)', fontSize: 11.5, fontWeight: 400 }}>(confiabilidad)</span></h3>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 14 }}>A mayor volumen, mayor confianza</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ConfianzaRow label="Alta confianza" sub="30+ leads" count={tiers.high.length} color="#22d68a" />
        <ConfianzaRow label="Media confianza" sub="10 - 29 leads" count={tiers.mid.length} color="#f5c842" />
        <ConfianzaRow label="Baja confianza" sub="< 10 leads" count={tiers.low.length} color="#f05a5a" />
      </div>
    </div>
  )
}
function ConfianzaRow({ label, sub, count, color }: { label: string; sub: string; count: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
          <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{label}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, marginLeft: 16 }}>{sub}</div>
      </div>
      <span style={{ fontSize: 11, color: count > 0 ? color : 'var(--text3)', fontWeight: 600 }}>
        {count} segmento{count === 1 ? '' : 's'}
      </span>
    </div>
  )
}

function VelocidadCierreCard({ cycle }: { cycle: ReturnType<typeof cycleStats> }) {
  return (
    <div style={{ background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px' }}>
      <h3 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>Velocidad de cierre <span style={{ color: 'var(--text3)', fontSize: 11.5, fontWeight: 400 }}>(mediana)</span></h3>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 14 }}>Días desde creación a cierre</div>
      {cycle.count === 0
        ? <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>Aún no hay cierres en este rango.</div>
        : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 800, color: '#a594ff', lineHeight: 1 }}>
                {cycle.medianDays.toFixed(1)}
              </span>
              <span style={{ fontSize: 14, color: 'var(--text3)', fontWeight: 500 }}>días</span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 10 }}>
              Promedio {cycle.avgDays.toFixed(1)} d · {cycle.count} cerrados en el rango
            </div>
          </>
        )}
    </div>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────
type MovementData = {
  passCounts: StagePassCount[]
  transitions: TransitionStats[]
  advance: Partial<Record<Lead['status'], ForwardAdvance>>
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
    const nonDescartado = scoped.filter(l => l.status !== 'descartado')
    const cerrados = scoped.filter(l => PIPELINE_CLOSED.includes(l.status)).length
    const descartados = scoped.filter(l => l.status === 'descartado').length
    return {
      total,
      descartados,
      // Pipeline total = leads NO descartados (monto activo realista)
      pipeline: sumMonto(nonDescartado),
      pipelineCierre: sumMonto(scoped.filter(l => PIPELINE_CLOSING.includes(l.status))),
      pipelineCerrado: sumMonto(scoped.filter(l => PIPELINE_CLOSED.includes(l.status))),
      // Conv. rate sobre los que no descartaste (más honesto)
      conversionRate: nonDescartado.length > 0 ? cerrados / nonDescartado.length : 0,
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
      .catch(() => { if (!cancelled) setMovement({ passCounts: [], transitions: [], advance: {}, sample_size: 0 }) })
    return () => { cancelled = true }
  }, [dateRange])

  // tactics removidas — user pidió sin sugerencias en este rediseño

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
          {/* Sidebar minimal — info clave está en el hero del body, no duplicada. */}
          <div className={styles.kpi}><span>Total leads</span><strong>{stats.total}</strong></div>
          <div className={styles.kpi}><span>Convertidos</span><strong>{stats.cerrados}</strong></div>
          <div className={styles.kpi}><span>Conv. rate</span><strong>{fmtPct(stats.conversionRate)}</strong></div>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <h1>Analítica — {DATE_LABELS[dateRange]}</h1>
        </header>

        <div className={styles.body}>
          {/* HERO: 4 KPI cards limpias */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
            <KPICard label="Ventas cerradas" value={fmtMoney(stats.pipelineCerrado)} sub={`${stats.cerrados} deals · ${DATE_LABELS[dateRange].toLowerCase()}`} accentColor="#22d68a" />
            <KPICard label="Forecast ponderado" value={fmtMoney(stats.forecast)} sub={`Meta ${fmtMoney(periodGoal)}`} accentColor="#a594ff" />
            <KPICard label="Tasa de conversión" value={fmtPct(stats.conversionRate)} sub={`${stats.cerrados} de ${stats.total - stats.descartados} (sin descartados)`} accentColor="#4ea8f5" />
            <KPICard label="Leads totales" value={String(stats.total)} sub={`${stats.descartados} descartados`} accentColor="var(--text)" />
          </div>

          {/* Main: tabla con tabs + sidebar insights */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
            <TabsTable byCanal={byCanal} byVacante={byVacante} byPresupuesto={byPresupuesto} byEstado={byEstado} avgConvRate={stats.conversionRate} />
            <InsightsSidebar insights={buildInsights({ byCanal, byPresupuesto, avgConvRate: stats.conversionRate, totalLeads: stats.total })} />
          </div>

          {/* Bottom row — 4 cards compactas */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
            <EficienciaPorCanal byCanal={byCanal} />
            <DistribucionConversiones leads={scoped} />
            <VolumenConfianza byCanal={byCanal} />
            <VelocidadCierreCard cycle={stats.cycle} />
          </div>

          {/* Funnel de ventas + Ventas por semana + Leads por día */}
          <FunnelChart leads={scoped} cycle={stats.cycle} />
          <WeeklyConversionChart leads={scoped} range={dateRange} />
          <DailyTimeline leads={scoped} range={dateRange} />
        </div>
      </main>
    </div>
  )
}
