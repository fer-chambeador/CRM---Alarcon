'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase, type Lead } from '@/lib/supabase'
import { Sidebar } from './CommandCenter'
import {
  STATUS_LABELS, statusColor, fmtMoney, fmtHours, sumMonto,
  PIPELINE_CLOSED, getLeadAlert, type LeadAlert, alertColor, DEFAULT_MONTO,
} from '@/lib/status'
import clsx from 'clsx'
import styles from './CommandCenter.module.css'

type AlertedLead = { lead: Lead; alert: LeadAlert }

export default function PendientesClient({ initialLeads }: { initialLeads: Lead[] }) {
  const router = useRouter()
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [now, setNow] = useState(Date.now())

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

  // New leads today (by created_at)
  const newToday = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return leads.filter(l => l.status === 'nuevo' && new Date(l.created_at) >= today)
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
          <h1>⏰ Pendientes de hoy</h1>
        </header>

        <div className={styles.body}>
          <div className={styles.kpiRow}>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Alertas activas</div>
              <div className={styles.kpiValue} style={{ color: totalAlerts > 0 ? '#f5914e' : 'var(--text)' }}>{totalAlerts}</div>
              <div className={styles.kpiSub}>{groups.urgent.length} urgentes · {totalAlerts - groups.urgent.length} warning</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Pipeline en riesgo</div>
              <div className={styles.kpiValue} style={{ color: '#f5c842' }}>{fmtMoney(pipelineAtRisk)}</div>
              <div className={styles.kpiSub}>Suma de montos en alerta</div>
            </div>
            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Leads nuevos hoy</div>
              <div className={styles.kpiValue}>{newToday.length}</div>
              <div className={styles.kpiSub}>{fmtMoney(sumMonto(newToday))} en pipeline · sin contactar</div>
            </div>
          </div>

          <Group title="🚨 Urgentes — último seguimiento (>96h)" rows={groups.urgent} onAction={updateStatus} onOpen={(l) => router.push(`/leads?lead=${l.id}`)} emptyText="Nada urgente. Bien." />
          <Group title="⏳ Follow up — contactados sin avance (>48h)" rows={groups.followUp} onAction={updateStatus} onOpen={(l) => router.push(`/leads?lead=${l.id}`)} emptyText="Nada que fallowear." />
          <Group title="📞 Llamadas agendadas pendientes de actualizar (>24h)" rows={groups.llamada} onAction={updateStatus} onOpen={(l) => router.push(`/leads?lead=${l.id}`)} emptyText="Todas las llamadas al día." />
          <Group title="📤 Presentaciones esperando resultado (>48h)" rows={groups.presentacion} onAction={updateStatus} onOpen={(l) => router.push(`/leads?lead=${l.id}`)} emptyText="Sin presentaciones colgando." />

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
      </main>
    </div>
  )
}

function Group({ title, rows, onAction, onOpen, emptyText }: {
  title: string; rows: AlertedLead[];
  onAction: (id: string, s: Lead['status']) => void;
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
                    <button key={a.status} className={clsx(styles.nbaActionBtn, i === 0 && styles.nbaActionPrimary)}
                      style={{ '--ac': statusColor(a.status) } as React.CSSProperties}
                      onClick={() => onAction(lead.id, a.status)}>
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
