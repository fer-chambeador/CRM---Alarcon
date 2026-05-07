'use client'

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase, type Lead } from '@/lib/supabase'
import {
  STATUS_LABELS, statusColor, fmtMoney, fmtPct, fmtHours, sumMonto,
  PIPELINE_CLOSED, PIPELINE_CLOSING, getLeadAlert, type LeadAlert, alertColor,
} from '@/lib/status'
import { startOfMonth, subMonths, isAfter } from 'date-fns'
import clsx from 'clsx'
import styles from './CommandCenter.module.css'

const MONTHLY_GOAL = 200000

type AlertedLead = { lead: Lead; alert: LeadAlert }

export default function CommandCenter({ initialLeads }: { initialLeads: Lead[] }) {
  const router = useRouter()
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [now, setNow] = useState(Date.now())

  // Realtime
  useEffect(() => {
    const ch = supabase.channel('cc-leads')
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

  // Tick every 5 min so alerts re-evaluate without a reload
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  // Keyboard: ⌘K opens palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault(); setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Optimistic status patch
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

  // ── Stats ──
  const stats = useMemo(() => {
    const monthStart = startOfMonth(new Date())
    const lastMonthStart = startOfMonth(subMonths(new Date(), 1))
    const inMonth = (l: Lead) => isAfter(new Date(l.created_at), monthStart)
    const inLastMonth = (l: Lead) => {
      const d = new Date(l.created_at)
      return d >= lastMonthStart && d < monthStart
    }

    const monthLeads = leads.filter(inMonth)
    const lastMonthLeads = leads.filter(inLastMonth)

    const closedMonth = monthLeads.filter(l => PIPELINE_CLOSED.includes(l.status))
    const closedLast = lastMonthLeads.filter(l => PIPELINE_CLOSED.includes(l.status))
    const cierreMonth = monthLeads.filter(l => PIPELINE_CLOSING.includes(l.status))

    const conversionMonth = monthLeads.length > 0 ? closedMonth.length / monthLeads.length : 0
    const conversionLast = lastMonthLeads.length > 0 ? closedLast.length / lastMonthLeads.length : 0

    return {
      pipelineCerrado: sumMonto(closedMonth),
      pipelineCerradoCount: closedMonth.length,
      goalPct: Math.min(1, sumMonto(closedMonth) / MONTHLY_GOAL),
      pipelineCierre: sumMonto(cierreMonth),
      pipelineCierreCount: cierreMonth.length,
      conversion: conversionMonth,
      conversionDelta: conversionMonth - conversionLast,
      monthLeadsCount: monthLeads.length,
    }
  }, [leads])

  // ── Alerts feed (sorted by urgency, then by hours) ──
  const alerted = useMemo<AlertedLead[]>(() => {
    return leads
      .map(lead => ({ lead, alert: getLeadAlert(lead, now) }))
      .filter((x): x is AlertedLead => x.alert !== null)
      .sort((a, b) => {
        const lvl = (l: 'urgent' | 'warning') => l === 'urgent' ? 2 : 1
        return lvl(b.alert.level) - lvl(a.alert.level) || b.alert.hours - a.alert.hours
      })
      .slice(0, 12)
  }, [leads, now])

  // Alerts count for sidebar badge
  const alertsCount = useMemo(() => leads.filter(l => getLeadAlert(l, now) !== null).length, [leads, now])

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar alertsCount={alertsCount} active="dashboard" />
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <h1>Hoy</h1>
          <div className={styles.topBarSpacer} />
          <button className={styles.cmdBtn} onClick={() => setPaletteOpen(true)}>
            <span>⌘ Buscar o ejecutar</span>
            <kbd>⌘K</kbd>
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.kpiRow}>
            <div className={clsx(styles.kpiCard, styles.kpiCardTeal)}>
              <div className={styles.kpiLabel}>Pipeline cerrado · este mes</div>
              <div className={styles.kpiValue}>{fmtMoney(stats.pipelineCerrado)}</div>
              <div className={styles.kpiSub}>
                {stats.pipelineCerradoCount} deals · meta {fmtMoney(MONTHLY_GOAL)} ({Math.round(stats.goalPct * 100)}%)
              </div>
              <div className={styles.kpiBar}>
                <div className={styles.kpiBarFill} style={{ width: `${stats.goalPct * 100}%`, background: 'rgba(255,255,255,0.7)' }} />
              </div>
            </div>
            <div className={clsx(styles.kpiCard, styles.kpiCardPurple)}>
              <div className={styles.kpiLabel}>En cierre · este mes</div>
              <div className={styles.kpiValue}>{fmtMoney(stats.pipelineCierre)}</div>
              <div className={styles.kpiSub}>{stats.pipelineCierreCount} leads en presentación / espera</div>
            </div>
            <div className={clsx(styles.kpiCard, styles.kpiCardIndigo)}>
              <div className={styles.kpiLabel}>Conversion rate · este mes</div>
              <div className={styles.kpiValue}>{fmtPct(stats.conversion)}</div>
              <div className={styles.kpiSub}>
                {stats.pipelineCerradoCount} / {stats.monthLeadsCount} ·{' '}
                {stats.conversionDelta >= 0 ? '▲' : '▼'} {Math.abs(stats.conversionDelta * 100).toFixed(1)}pp vs mes pasado
              </div>
            </div>
          </div>

          <section className={styles.section}>
            <header className={styles.sectionHeader}>
              <h3>⚡ Next best actions</h3>
              <span className={styles.sectionSubtitle}>
                {alerted.length === 0 ? 'Todo al día — nada pendiente' : `${alerted.length} pendiente${alerted.length === 1 ? '' : 's'}`}
              </span>
            </header>
            {alerted.length === 0
              ? <div className={styles.empty}>Sin alertas. Todo el pipeline está dentro de los SLAs.</div>
              : (
                <div className={styles.nbaList}>
                  {alerted.map(({ lead, alert }) => (
                    <NBAItem key={lead.id} lead={lead} alert={alert} onAction={updateStatus} onOpen={() => router.push(`/leads?lead=${lead.id}`)} />
                  ))}
                </div>
              )}
          </section>
        </div>

        {paletteOpen && (
          <CommandPalette leads={leads} onClose={() => setPaletteOpen(false)} onUpdateStatus={updateStatus} />
        )}
      </main>
    </div>
  )
}

// ─── Sidebar (shared shape across pages) ─────────────────────────────────────
export function Sidebar({ alertsCount, active }: { alertsCount?: number; active: 'dashboard' | 'leads' | 'pendientes' | 'analytics' | 'asistente' }) {
  const link = (href: string, key: string, label: string, icon: string) => (
    <Link href={href} className={clsx(styles.navLink, active === key && styles.navLinkActive)}>
      <span>{icon} {label}</span>
      {key === 'pendientes' && alertsCount && alertsCount > 0
        ? <span className={styles.navBadge}>{alertsCount}</span>
        : null}
    </Link>
  )
  return (
    <nav className={styles.sidebarNav}>
      {link('/dashboard', 'dashboard', 'Hoy', '🎯')}
      {link('/pendientes', 'pendientes', 'Pendientes', '⏰')}
      {link('/leads', 'leads', 'Leads', '📋')}
      {link('/analytics', 'analytics', 'Analítica', '📊')}
      {link('/asistente', 'asistente', 'Asistente', '🧠')}
    </nav>
  )
}

// ─── NBA Item ────────────────────────────────────────────────────────────────
function NBAItem({ lead, alert, onAction, onOpen }: {
  lead: Lead; alert: LeadAlert; onAction: (id: string, s: Lead['status']) => void; onOpen: () => void
}) {
  const ac = alertColor(alert.level)
  return (
    <div className={styles.nbaItem} style={{ '--ac': ac } as React.CSSProperties}>
      <div className={styles.nbaBody} onClick={onOpen} style={{ cursor: 'pointer' }}>
        <div className={styles.nbaHead}>
          <span className={styles.nbaName}>{lead.nombre || lead.empresa || lead.email}</span>
          <span className={styles.nbaEmail}>{lead.email}</span>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {STATUS_LABELS[lead.status]} {fmtHours(alert.hours)}</span>
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
  )
}

// ─── Command Palette (⌘K) ───────────────────────────────────────────────────
type PaletteItem =
  | { kind: 'nav'; label: string; href: string }
  | { kind: 'lead'; lead: Lead }
  | { kind: 'create' }

function CommandPalette({ leads, onClose, onUpdateStatus: _ }: {
  leads: Lead[]; onClose: () => void; onUpdateStatus: (id: string, s: Lead['status']) => void
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const items = useMemo<PaletteItem[]>(() => {
    const navs: PaletteItem[] = [
      { kind: 'nav', label: '🎯 Ir a Hoy', href: '/dashboard' },
      { kind: 'nav', label: '⏰ Ver pendientes', href: '/pendientes' },
      { kind: 'nav', label: '📋 Lista de leads', href: '/leads' },
      { kind: 'nav', label: '📊 Analítica', href: '/analytics' },
      { kind: 'nav', label: '🧠 Asistente', href: '/asistente' },
      { kind: 'create' },
    ]
    if (!q.trim()) return navs
    const lower = q.toLowerCase()
    const matchedLeads: PaletteItem[] = leads
      .filter(l =>
        (l.email || '').toLowerCase().includes(lower) ||
        (l.nombre || '').toLowerCase().includes(lower) ||
        (l.empresa || '').toLowerCase().includes(lower)
      )
      .slice(0, 8)
      .map(lead => ({ kind: 'lead' as const, lead }))
    const matchedNavs = navs.filter(n => n.kind === 'nav' && (n as { label: string }).label.toLowerCase().includes(lower))
    return [...matchedLeads, ...matchedNavs]
  }, [q, leads])

  useEffect(() => { setActive(0) }, [q])

  const exec = useCallback((it: PaletteItem) => {
    if (it.kind === 'nav') router.push(it.href)
    else if (it.kind === 'lead') router.push(`/leads?lead=${it.lead.id}`)
    else if (it.kind === 'create') router.push('/leads?new=1')
    onClose()
  }, [router, onClose])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(items.length - 1, a + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    if (e.key === 'Enter') { const it = items[active]; if (it) exec(it) }
  }

  return (
    <div className={styles.paletteOverlay} onClick={onClose}>
      <div className={styles.palette} onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className={styles.paletteInput}
          placeholder="Buscar lead o ejecutar acción..."
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className={styles.paletteList}>
          {items.length === 0 && <div className={styles.empty}>Sin resultados</div>}
          {items.map((it, i) => (
            <div key={i}
              className={clsx(styles.paletteItem, i === active && styles.paletteItemActive)}
              onClick={() => exec(it)}
              onMouseEnter={() => setActive(i)}>
              {it.kind === 'nav' && <span>{it.label}</span>}
              {it.kind === 'create' && <span>✏️ Crear lead nuevo</span>}
              {it.kind === 'lead' && (
                <>
                  <span>{it.lead.nombre || it.lead.empresa || '—'}</span>
                  <span className={styles.paletteItemSub}>{it.lead.email}</span>
                </>
              )}
            </div>
          ))}
        </div>
        <div className={styles.paletteFooter}>
          <span><kbd>↵</kbd> ejecutar</span>
          <span><kbd>↑↓</kbd> navegar</span>
          <span><kbd>Esc</kbd> cerrar</span>
        </div>
      </div>
    </div>
  )
}
