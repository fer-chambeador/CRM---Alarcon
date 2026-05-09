'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase, type Lead } from '@/lib/supabase'
import { Sidebar, InsightsSection, CommandPalette } from './CommandCenter'
import {
  STATUS_LABELS, statusColor, fmtMoney, fmtHours, sumMonto,
  PIPELINE_CLOSED, getLeadAlert, type LeadAlert, type AlertAction, alertColor, DEFAULT_MONTO,
} from '@/lib/status'
import { startOfMonth, format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import clsx from 'clsx'
import styles from './CommandCenter.module.css'

const MONTHLY_GOAL = 200000

type AlertedLead = { lead: Lead; alert: LeadAlert }

export default function PendientesClient({ initialLeads }: { initialLeads: Lead[] }) {
  const router = useRouter()
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [now, setNow] = useState(Date.now())
  const [paletteOpen, setPaletteOpen] = useState(false)

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

  // Tick alerts
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  // ⌘K
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

  // ── Derived state ──
  const alerted = useMemo<AlertedLead[]>(() => {
    return leads
      .map(lead => ({ lead, alert: getLeadAlert(lead, now) }))
      .filter((x): x is AlertedLead => x.alert !== null)
  }, [leads, now])

  const groups = useMemo(() => {
    const urgent = alerted.filter(a => a.alert.level === 'urgent')
      .sort((a, b) => b.alert.hours - a.alert.hours)
    const followUp = alerted.filter(a => a.alert.kind === 'follow_up')
      .sort((a, b) => b.alert.hours - a.alert.hours)
    const llamada = alerted.filter(a => a.alert.kind === 'llamada_pending')
      .sort((a, b) => b.alert.hours - a.alert.hours)
    const presentacion = alerted.filter(a => a.alert.kind === 'presentacion_pending')
      .sort((a, b) => b.alert.hours - a.alert.hours)
    return { urgent, followUp, llamada, presentacion }
  }, [alerted])

  const newToday = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return leads.filter(l => l.status === 'nuevo' && new Date(l.created_at) >= today)
  }, [leads])

  // Próximas llamadas (next 7 days)
  const upcomingCalls = useMemo(() => {
    return leads
      .filter(l => l.status === 'llamada_agendada' && l.llamada_at)
      .map(l => ({ lead: l, when: new Date(l.llamada_at!).getTime() }))
      .filter(x => x.when >= now - 60 * 60 * 1000 && x.when <= now + 7 * 24 * 60 * 60 * 1000)
      .sort((a, b) => a.when - b.when)
      .slice(0, 8)
  }, [leads, now])

  // Strategic KPIs (this month)
  const monthStats = useMemo(() => {
    const monthStart = startOfMonth(new Date())
    const monthLeads = leads.filter(l => new Date(l.created_at) >= monthStart)
    const closed = monthLeads.filter(l => PIPELINE_CLOSED.includes(l.status))
    return {
      pipelineCerrado: sumMonto(closed),
      pipelineCerradoCount: closed.length,
      goalPct: Math.min(1, sumMonto(closed) / MONTHLY_GOAL),
    }
  }, [leads])

  const totalAlerts = alerted.length
  const pipelineAtRisk = sumMonto(alerted.map(a => a.lead).filter(l => !PIPELINE_CLOSED.includes(l.status)))

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar alertsCount={totalAlerts} active="pendientes" />
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <h1>⏰ Pendientes</h1>
          <div className={styles.topBarSpacer} />
          <button className={styles.cmdBtn} onClick={() => setPaletteOpen(true)}>
            <span>⌘ Buscar o ejecutar</span>
            <kbd>⌘K</kbd>
          </button>
        </header>

        <div className={styles.body}>
          {/* ── Strategic KPIs ── */}
          <div className={styles.kpiRow}>
            <div className={clsx(styles.kpiCard, styles.kpiCardTeal)}>
              <div className={styles.kpiLabel}>Pipeline cerrado · este mes</div>
              <div className={styles.kpiValue}>{fmtMoney(monthStats.pipelineCerrado)}</div>
              <div className={styles.kpiSub}>
                {monthStats.pipelineCerradoCount} deals · meta {fmtMoney(MONTHLY_GOAL)} ({Math.round(monthStats.goalPct * 100)}%)
              </div>
              <div className={styles.kpiBar}>
                <div className={styles.kpiBarFill} style={{ width: `${monthStats.goalPct * 100}%`, background: 'rgba(255,255,255,0.7)' }} />
              </div>
            </div>
            <div className={clsx(styles.kpiCard, styles.kpiCardPurple)}>
              <div className={styles.kpiLabel}>Alertas activas</div>
              <div className={styles.kpiValue}>{totalAlerts}</div>
              <div className={styles.kpiSub}>{groups.urgent.length} urgentes · {totalAlerts - groups.urgent.length} warning</div>
            </div>
            <div className={clsx(styles.kpiCard, styles.kpiCardIndigo)}>
              <div className={styles.kpiLabel}>Pipeline en riesgo</div>
              <div className={styles.kpiValue}>{fmtMoney(pipelineAtRisk)}</div>
              <div className={styles.kpiSub}>Suma de montos en alerta · revisalos abajo</div>
            </div>
          </div>

          <InsightsSection />

          {upcomingCalls.length > 0 && (
            <section className={styles.section}>
              <header className={styles.sectionHeader}>
                <h3>📞 Próximas llamadas</h3>
                <span className={styles.sectionSubtitle}>
                  {upcomingCalls.length} agendada{upcomingCalls.length === 1 ? '' : 's'} en los próximos 7 días
                </span>
              </header>
              <div className={styles.nbaList}>
                {upcomingCalls.map(({ lead, when }) => {
                  const dt = new Date(when)
                  const minsUntil = (when - now) / 60000
                  const isImminent = minsUntil >= 0 && minsUntil <= 60
                  const isPast = minsUntil < 0
                  return (
                    <div key={lead.id} className={styles.nbaItem}
                      style={{ '--ac': isImminent ? '#ff5a5a' : isPast ? '#ffba3d' : '#a594ff' } as React.CSSProperties}>
                      <div className={styles.nbaBody} onClick={() => router.push(`/leads?lead=${lead.id}`)} style={{ cursor: 'pointer' }}>
                        <div className={styles.nbaHead}>
                          <span className={styles.nbaName}>{lead.nombre || lead.empresa || lead.email}</span>
                          <span className={styles.nbaEmail}>{lead.email}</span>
                        </div>
                        <div className={styles.nbaText}>
                          {format(dt, "EEEE d 'de' MMM, HH:mm", { locale: es })}
                          {' · '}
                          {isImminent ? <strong style={{ color: '#ff5a5a' }}>en {Math.round(minsUntil)} min</strong>
                            : isPast ? <strong style={{ color: '#ffba3d' }}>hace {formatDistanceToNow(dt, { locale: es })}</strong>
                            : <span style={{ color: 'var(--text2)' }}>en {formatDistanceToNow(dt, { locale: es })}</span>}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          <Group title="🚨 Urgentes — descartar por intentos" rows={groups.urgent}
            onAction={dispatchAction} onOpen={(l) => router.push(`/leads?lead=${l.id}`)}
            emptyText="Nada urgente. Bien." />
          <Group title="⏳ Follow up — contactados sin avance 72 h hábiles" rows={groups.followUp}
            onAction={dispatchAction} onOpen={(l) => router.push(`/leads?lead=${l.id}`)}
            emptyText="Sin follow-ups pendientes." />
          <Group title="📞 Llamadas pendientes de actualizar" rows={groups.llamada}
            onAction={dispatchAction} onOpen={(l) => router.push(`/leads?lead=${l.id}`)}
            emptyText="Todas las llamadas al día." />
          <Group title="📤 Propuestas esperando resultado (>48h)" rows={groups.presentacion}
            onAction={dispatchAction} onOpen={(l) => router.push(`/leads?lead=${l.id}`)}
            emptyText="Sin propuestas colgando." />

          {newToday.length > 0 && (
            <section className={styles.section}>
              <header className={styles.sectionHeader}>
                <h3>🆕 Leads nuevos hoy — sin contactar</h3>
                <span className={styles.sectionSubtitle}>{newToday.length} · entrá rápido para no quemarte el follow-up window</span>
              </header>
              <div className={styles.nbaList}>
                {newToday.map(lead => (
                  <div key={lead.id} className={styles.nbaItem} style={{ '--ac': statusColor('nuevo') } as React.CSSProperties}>
                    <div className={styles.nbaBody} onClick={() => router.push(`/leads?lead=${lead.id}`)} style={{ cursor: 'pointer' }}>
                      <div className={styles.nbaHead}>
                        <span className={styles.nbaName}>{lead.nombre || lead.empresa || lead.email}</span>
                        <span className={styles.nbaEmail}>{lead.email}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {lead.canal_adquisicion || 'sin canal'} · {fmtMoney(lead.monto ?? DEFAULT_MONTO)}</span>
                      </div>
                    </div>
                    <div className={styles.nbaActions}>
                      <button className={clsx(styles.nbaActionBtn, styles.nbaActionPrimary)}
                        style={{ '--ac': statusColor('contactado') } as React.CSSProperties}
                        onClick={() => updateStatus(lead.id, 'contactado')}>
                        Marcar contactado
                      </button>
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

function Group({ title, rows, onAction, onOpen, emptyText }: {
  title: string; rows: AlertedLead[];
  onAction: (id: string, action: AlertAction) => void;
  onOpen: (l: Lead) => void;
  emptyText: string
}) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <h3>{title}</h3>
        <span className={styles.sectionSubtitle}>{rows.length === 0 ? emptyText : `${rows.length} pendiente${rows.length === 1 ? '' : 's'}`}</span>
      </header>
      {rows.length === 0
        ? <div className={styles.empty}>{emptyText}</div>
        : (
          <div className={styles.nbaList}>
            {rows.map(({ lead, alert }) => (
              <div key={lead.id} className={styles.nbaItem} style={{ '--ac': alertColor(alert.level) } as React.CSSProperties}>
                <div className={styles.nbaBody} onClick={() => onOpen(lead)} style={{ cursor: 'pointer' }}>
                  <div className={styles.nbaHead}>
                    <span className={styles.nbaName}>{lead.nombre || lead.empresa || lead.email}</span>
                    <span className={styles.nbaEmail}>{lead.email}</span>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {STATUS_LABELS[lead.status]} {fmtHours(alert.hours)} · {fmtMoney(lead.monto ?? DEFAULT_MONTO)}</span>
                  </div>
                  <div className={styles.nbaText}>{alert.text}</div>
                </div>
                <div className={styles.nbaActions}>
                  {alert.actions.map((a, i) => (
                    <button key={i} className={clsx(styles.nbaActionBtn, i === 0 && styles.nbaActionPrimary)}
                      style={{ '--ac': a.status ? statusColor(a.status) : '#7c54e8' } as React.CSSProperties}
                      onClick={() => onAction(lead.id, a)}>
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
    </section>
  )
}
