'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase, type Lead } from '@/lib/supabase'
import { Sidebar, CommandPalette } from './CommandCenter'
import {
  STATUS_LABELS, statusColor, fmtMoney, fmtHours, sumMonto,
  PIPELINE_CLOSED, getLeadAlert, type LeadAlert, type AlertAction, alertColor, DEFAULT_MONTO,
} from '@/lib/status'
import { startOfMonth, startOfWeek, format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import clsx from 'clsx'
import styles from './CommandCenter.module.css'
import { WEEKLY_GOAL, MONTHLY_GOAL } from '@/lib/goal'
import { STATUS_WIN_PROBABILITY } from '@/lib/forecast'

/**
 * /pendientes — vista minimalista de decisión.
 *
 * Filosofía: la página existe para responder UNA pregunta — "¿qué hago
 * ahora?". Una sola jerarquía: la próxima acción más impactante, después
 * la siguiente. Sin grupos paralelos, sin KPIs decorativos.
 */

type Action = {
  lead: Lead
  alert: LeadAlert | null
  priority: number         // mayor = más urgente
  kind: 'call_imminent' | 'call_past' | 'call_today' | 'urgent' | 'proposal_aging' | 'follow_up' | 'new_today'
  text: string             // copy corto que explica qué hacer
  primaryAction: AlertAction | { status: Lead['status']; label: string } | { incrementarContacto: true; label: string }
}

/** Prioridad combinada: urgencia × probabilidad de cierre × monto. */
function actionPriority(lead: Lead, baseUrgency: number): number {
  const monto = lead.monto ?? DEFAULT_MONTO
  const prob = STATUS_WIN_PROBABILITY[lead.status] || 0.05
  // baseUrgency domina, luego monto × prob como tiebreaker
  return baseUrgency * 1_000_000 + monto * prob
}

export default function PendientesClient({ initialLeads }: { initialLeads: Lead[] }) {
  const router = useRouter()
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [now, setNow] = useState(Date.now())
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [period, setPeriod] = useState<'semana' | 'mes'>('semana')

  // Realtime
  useEffect(() => {
    const ch = supabase.channel('pendientes-leads')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, (p) => {
        if (p.eventType === 'INSERT') setLeads(prev => [p.new as Lead, ...prev])
        else if (p.eventType === 'UPDATE') {
          const u = p.new as Lead
          setLeads(prev => prev.map(l => l.id === u.id ? u : l))
        } else if (p.eventType === 'DELETE') {
          const id = (p.old as Lead).id
          setLeads(prev => prev.filter(l => l.id !== id))
        }
      }).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault(); setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Mutations ──
  const updateStatus = useCallback(async (leadId: string, newStatus: Lead['status']) => {
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: newStatus, status_changed_at: new Date().toISOString() } : l))
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const u = await res.json()
      if (u && u.id) setLeads(prev => prev.map(l => l.id === u.id ? u : l))
    } catch {}
  }, [])

  const bumpContacto = useCallback(async (leadId: string) => {
    setLeads(prev => prev.map(l => l.id === leadId
      ? { ...l, veces_contactado: (l.veces_contactado || 0) + 1, ultimo_contacto: new Date().toISOString() }
      : l))
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incrementar_contacto: true }),
      })
      const u = await res.json()
      if (u && u.id) setLeads(prev => prev.map(l => l.id === u.id ? u : l))
    } catch {}
  }, [])

  const dispatchAction = useCallback((leadId: string, action: AlertAction) => {
    if (action.incrementarContacto) bumpContacto(leadId)
    else if (action.status) updateStatus(leadId, action.status)
  }, [bumpContacto, updateStatus])

  // ── Construir Top acciones de hoy (jerarquizadas) ──
  const actions = useMemo<Action[]>(() => {
    const out: Action[] = []
    const today = new Date(); today.setHours(0, 0, 0, 0)

    for (const lead of leads) {
      if (PIPELINE_CLOSED.includes(lead.status) || lead.status === 'descartado') continue

      // 1. Llamada inminente / hoy / pasada
      if (lead.status === 'llamada_agendada' && lead.llamada_at) {
        const callMs = new Date(lead.llamada_at).getTime()
        const mins = (callMs - now) / 60000
        if (mins > 0 && mins <= 60) {
          out.push({
            lead, alert: null, priority: actionPriority(lead, 100),
            kind: 'call_imminent',
            text: `Llamada en ${Math.round(mins)} min`,
            primaryAction: { label: 'Propuesta enviada', status: 'presentacion_enviada' },
          })
          continue
        }
        if (mins < 0 && mins > -7 * 24 * 60) {
          out.push({
            lead, alert: null, priority: actionPriority(lead, 90),
            kind: 'call_past',
            text: `Llamada fue ${formatDistanceToNow(new Date(callMs), { locale: es })} — actualizá resultado`,
            primaryAction: { label: 'Propuesta enviada', status: 'presentacion_enviada' },
          })
          continue
        }
        if (mins >= 0 && mins <= 24 * 60) {
          out.push({
            lead, alert: null, priority: actionPriority(lead, 80),
            kind: 'call_today',
            text: `Llamada hoy ${format(new Date(callMs), 'HH:mm', { locale: es })} — preparate`,
            primaryAction: { label: 'Marcar contactado', incrementarContacto: true },
          })
          continue
        }
      }

      // 2. Alertas de negocio (urgent / follow_up / propuesta vieja)
      const alert = getLeadAlert(lead, now)
      if (alert) {
        const base = alert.level === 'urgent' ? 70 : 50
        const kind: Action['kind'] = alert.kind === 'presentacion_pending'
          ? 'proposal_aging'
          : alert.kind === 'last_chance'
            ? 'urgent'
            : 'follow_up'
        out.push({
          lead, alert, priority: actionPriority(lead, base),
          kind, text: alert.text,
          primaryAction: alert.actions[0],
        })
        continue
      }

      // 3. Nuevo hoy sin contactar
      if (lead.status === 'nuevo' && new Date(lead.created_at) >= today) {
        out.push({
          lead, alert: null, priority: actionPriority(lead, 30),
          kind: 'new_today',
          text: 'Lead nuevo de hoy — entrá rápido antes de que se enfríe',
          primaryAction: { label: 'Marcar contactado', status: 'contactado' },
        })
      }
    }

    return out.sort((a, b) => b.priority - a.priority)
  }, [leads, now])

  // ── KPI cards: progreso al goal ──
  const progress = useMemo(() => {
    const start = period === 'semana' ? startOfWeek(new Date(), { weekStartsOn: 1 }) : startOfMonth(new Date())
    const inRange = leads.filter(l => new Date(l.created_at) >= start)
    const closed = inRange.filter(l => PIPELINE_CLOSED.includes(l.status))
    const cerrado = sumMonto(closed)
    const goal = period === 'semana' ? WEEKLY_GOAL : MONTHLY_GOAL
    const pipelineEnCierre = sumMonto(inRange.filter(l =>
      l.status === 'presentacion_enviada' || l.status === 'espera_aprobacion'
    ))
    return {
      cerrado, goal,
      pct: Math.min(1, cerrado / goal),
      count: closed.length,
      gap: Math.max(0, goal - cerrado),
      pipelineEnCierre,
    }
  }, [leads, period])

  // Próximas llamadas (próximos 7 días — solo si las hay y no entran en top actions)
  const upcomingCalls = useMemo(() => {
    return leads
      .filter(l => l.status === 'llamada_agendada' && l.llamada_at)
      .map(l => ({ lead: l, when: new Date(l.llamada_at!).getTime() }))
      .filter(x => x.when > now + 24 * 60 * 60 * 1000 && x.when <= now + 7 * 24 * 60 * 60 * 1000)
      .sort((a, b) => a.when - b.when)
  }, [leads, now])

  const visibleActions = showAll ? actions : actions.slice(0, 5)

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar alertsCount={actions.length} active="pendientes" />
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <h1>Pendientes</h1>
          <div className={styles.topBarSpacer} />
          <div style={{ display: 'flex', gap: 6, padding: '4px', background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 999 }}>
            {(['semana', 'mes'] as const).map(p => (
              <button key={p}
                onClick={() => setPeriod(p)}
                style={{
                  background: period === p ? 'var(--accent)' : 'transparent',
                  color: period === p ? 'white' : 'var(--text2)',
                  border: 'none', borderRadius: 999, padding: '6px 14px',
                  fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font)',
                  textTransform: 'capitalize',
                }}>
                {p === 'semana' ? 'Esta semana' : 'Este mes'}
              </button>
            ))}
          </div>
          <button className={styles.cmdBtn} onClick={() => setPaletteOpen(true)}>
            <span>⌘ Buscar</span><kbd>⌘K</kbd>
          </button>
        </header>

        <div className={styles.body}>
          {/* ── KPI hero: progreso al goal ────────────── */}
          <div className={styles.kpiRow}>
            <div className={clsx(styles.kpiCard, styles.kpiCardTeal)} style={{ gridColumn: 'span 2' }}>
              <div className={styles.kpiLabel}>Cerrado {period === 'semana' ? 'esta semana' : 'este mes'}</div>
              <div className={styles.kpiValue}>{fmtMoney(progress.cerrado)}</div>
              <div className={styles.kpiSub}>
                {progress.count} deal{progress.count === 1 ? '' : 's'} · meta {fmtMoney(progress.goal)}
                {' · '}{Math.round(progress.pct * 100)}%
                {progress.gap > 0 && <> · faltan <strong>{fmtMoney(progress.gap)}</strong></>}
              </div>
              <div className={styles.kpiBar}>
                <div className={styles.kpiBarFill}
                  style={{ width: `${progress.pct * 100}%`, background: 'rgba(255,255,255,0.85)' }} />
              </div>
            </div>
            <div className={clsx(styles.kpiCard, styles.kpiCardPurple)}>
              <div className={styles.kpiLabel}>Acciones de hoy</div>
              <div className={styles.kpiValue}>{actions.length}</div>
              <div className={styles.kpiSub}>
                {actions.length === 0 ? 'todo al día 🎉' : 'jerarquizadas por impacto'}
              </div>
            </div>
          </div>

          {/* ── Top acciones ───────────────────────────── */}
          <section className={styles.section}>
            <header className={styles.sectionHeader}>
              <div>
                <h3>Qué hacer ahora</h3>
                <span className={styles.sectionSubtitle}>
                  Top {Math.min(5, actions.length)} ordenadas por urgencia × probabilidad × monto.
                  {actions.length > 5 && !showAll && <> {actions.length - 5} más en cola.</>}
                </span>
              </div>
            </header>
            {actions.length === 0
              ? <div className={styles.empty}>Nada pendiente. Buen momento para generar pipeline nuevo.</div>
              : (
                <div className={styles.nbaList}>
                  {visibleActions.map((a, i) => (
                    <ActionRow key={a.lead.id} action={a} rank={i + 1}
                      onPrimary={() => {
                        if ('incrementarContacto' in a.primaryAction && a.primaryAction.incrementarContacto) {
                          bumpContacto(a.lead.id)
                        } else if ('status' in a.primaryAction && a.primaryAction.status) {
                          updateStatus(a.lead.id, a.primaryAction.status)
                        }
                      }}
                      onOpen={() => router.push(`/leads?lead=${a.lead.id}`)}
                    />
                  ))}
                  {actions.length > 5 && (
                    <button onClick={() => setShowAll(s => !s)}
                      style={{
                        background: 'transparent', border: '1px dashed var(--border2)',
                        color: 'var(--text3)', padding: '10px 16px', borderRadius: 12,
                        cursor: 'pointer', fontFamily: 'var(--font)', fontSize: 13, marginTop: 4,
                      }}>
                      {showAll ? `Mostrar solo top 5` : `Mostrar ${actions.length - 5} más`}
                    </button>
                  )}
                </div>
              )}
          </section>

          {/* ── Próximas llamadas (compacto, solo si las hay) ────────── */}
          {upcomingCalls.length > 0 && (
            <section className={styles.section}>
              <header className={styles.sectionHeader}>
                <div>
                  <h3>Llamadas en la semana</h3>
                  <span className={styles.sectionSubtitle}>{upcomingCalls.length} agendada{upcomingCalls.length === 1 ? '' : 's'} (24h+)</span>
                </div>
              </header>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
                {upcomingCalls.map(({ lead, when }) => (
                  <div key={lead.id}
                    onClick={() => router.push(`/leads?lead=${lead.id}`)}
                    style={{
                      background: 'var(--glass)', border: '1px solid var(--border)', borderRadius: 10,
                      padding: '10px 14px', cursor: 'pointer',
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>
                      {lead.nombre || lead.empresa || lead.email}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>
                      {format(new Date(when), "EEE d 'de' MMM, HH:mm", { locale: es })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {paletteOpen && (
          <CommandPalette leads={leads} onClose={() => setPaletteOpen(false)} onUpdateStatus={updateStatus} />
        )}
      </main>
    </div>
  )
}

// ─── ActionRow ───────────────────────────────────────────────────────────────
const KIND_COLOR: Record<Action['kind'], string> = {
  call_imminent:  '#ff5a5a',
  call_past:      '#ffba3d',
  call_today:     '#a594ff',
  urgent:         '#f05a5a',
  proposal_aging: '#a594ff',
  follow_up:      '#f5c842',
  new_today:      '#4ea8f5',
}

function ActionRow({ action, rank, onPrimary, onOpen }: {
  action: Action
  rank: number
  onPrimary: () => void
  onOpen: () => void
}) {
  const { lead, text, primaryAction } = action
  const monto = lead.monto ?? DEFAULT_MONTO
  const accent = KIND_COLOR[action.kind]
  return (
    <div className={styles.nbaItem} style={{ '--ac': accent } as React.CSSProperties}>
      <div className={styles.nbaBody} onClick={onOpen} style={{ cursor: 'pointer' }}>
        <div className={styles.nbaHead}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 6, background: accent + '22', color: accent,
            fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 12, marginRight: 8,
          }}>{rank}</span>
          <span className={styles.nbaName}>{lead.nombre || lead.empresa || lead.email}</span>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>
            · {STATUS_LABELS[lead.status]} · {fmtMoney(monto)}
          </span>
        </div>
        <div className={styles.nbaText}>{text}</div>
      </div>
      <div className={styles.nbaActions}>
        <button className={clsx(styles.nbaActionBtn, styles.nbaActionPrimary)}
          style={{ '--ac': accent } as React.CSSProperties}
          onClick={onPrimary}>
          {primaryAction.label}
        </button>
      </div>
    </div>
  )
}
