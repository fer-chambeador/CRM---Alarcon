'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Sidebar } from './CommandCenter'
import styles from './LlamadasClient.module.css'

type Lead = {
  id: string
  nombre: string | null
  email: string | null
  empresa: string | null
  telefono: string | null
  vacante: string | null
  presupuesto: string | null
  puesto: string | null
  canal_adquisicion: string | null
  llamada_at: string | null
  monto: number | null
  notas: string | null
  status: string
  created_at: string
}

type Aprobacion = {
  id: string
  tipo: 'vambe_template' | 'dapta_call'
  lead_id: string
  status: 'pending' | 'approved' | 'rejected_manual' | 'failed' | 'expired'
  template_id: string | null
  template_name: string | null
  scheduled_at: string | null
  reason: string | null
  score_snapshot: number | null
  created_at: string
  leads: Lead | null
}

type ApiResponse = {
  vambe: Aprobacion[]
  dapta: Aprobacion[]
  counts: { vambe: number; dapta: number; total: number }
}

type Tab = 'mensajes' | 'llamadas'

function fmtRelative(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'recién'
  if (m < 60) return `hace ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h}h`
  const d = Math.floor(h / 24)
  return `hace ${d}d`
}
function fmtFuture(iso: string | null): string {
  if (!iso) return '—'
  const ms = new Date(iso).getTime() - Date.now()
  if (ms < 0) return 'pasada'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `en ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `en ${h}h`
  const d = Math.floor(h / 24)
  return `en ${d}d`
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function OutboundClient() {
  const router = useRouter()
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('mensajes')
  const [busy, setBusy] = useState<Record<string, 'approve' | 'reject' | null>>({})

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/aprobaciones', { cache: 'no-store' })
      const json = await res.json() as ApiResponse
      setData(json)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { const i = setInterval(load, 30_000); return () => clearInterval(i) }, [load])

  const approve = async (id: string, dapta_immediate = false) => {
    setBusy(s => ({ ...s, [id]: 'approve' }))
    try {
      const res = await fetch(`/api/aprobaciones/${id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dapta_immediate }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert('Falló: ' + (err.error || res.status))
      }
      await load()
    } finally {
      setBusy(s => ({ ...s, [id]: null }))
    }
  }

  const reject = async (id: string) => {
    if (!confirm('¿Marcar como "lo hago manual"? Ya no se sugerirá de nuevo.')) return
    setBusy(s => ({ ...s, [id]: 'reject' }))
    try {
      await fetch(`/api/aprobaciones/${id}/reject`, { method: 'POST' })
      await load()
    } finally {
      setBusy(s => ({ ...s, [id]: null }))
    }
  }

  const summary = useMemo(() => ({
    vambe: data?.counts.vambe || 0,
    dapta: data?.counts.dapta || 0,
    total: data?.counts.total || 0,
  }), [data])

  const rows = tab === 'mensajes' ? (data?.vambe || []) : (data?.dapta || [])

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="aprobaciones" />
      </aside>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <h1>📨 Outbound</h1>
          <span className={styles.topBarSpacer} />
          <button className={styles.refreshBtn} onClick={load} disabled={loading}>
            {loading ? 'Cargando…' : '↻ Refresh'}
          </button>
        </div>

        <div className={styles.body}>
          {/* Summary cards */}
          <div className={styles.summary}>
            <Card label="Total pendiente" value={summary.total.toLocaleString('es-MX')} sub="aprobaciones esperando tu OK" />
            <Card label="📨 Mensajes Vambe" value={summary.vambe.toLocaleString('es-MX')} sub="leads warm/cold sin contactar" />
            <Card label="📞 Llamadas Dapta" value={summary.dapta.toLocaleString('es-MX')} sub="warm/cold con llamada agendada" />
            <Card label="🔥 Hot leads" value="manual" sub="los apretados los llamas tú" />
          </div>

          {/* Tab bar */}
          <div className={styles.filterBar} style={{ marginTop: 8 }}>
            <TabChip label={`📨 Mensajes (${summary.vambe})`} active={tab === 'mensajes'} onClick={() => setTab('mensajes')} />
            <TabChip label={`📞 Llamadas (${summary.dapta})`} active={tab === 'llamadas'} onClick={() => setTab('llamadas')} />
          </div>

          {/* Tabla — un solo formato para ambos tipos */}
          {rows.length === 0 && !loading && (
            <div style={{ padding: 60, textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
              {tab === 'mensajes'
                ? '✨ Nada pendiente. Los nuevos leads inbound warm/cold con 30+ min sin contactar aparecerán aquí.'
                : '✨ Nada pendiente. Los leads warm/cold con llamada agendada aparecerán aquí.'}
            </div>
          )}

          {rows.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Vacante / Empresa</th>
                    <th>Teléfono</th>
                    <th>Score</th>
                    <th>{tab === 'mensajes' ? 'Edad' : 'Cuándo'}</th>
                    <th style={{ width: 360 }}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(a => (
                    <tr key={a.id} style={{ cursor: a.leads ? 'pointer' : 'default' }}
                      onClick={() => a.leads && router.push(`/leads/${a.leads.id}`)}>
                      <td>
                        <div className={styles.leadName}>{a.leads?.nombre || a.leads?.email || '(sin nombre)'}</div>
                        {a.leads?.email && <div className={styles.muted} style={{ fontSize: 11 }}>{a.leads.email}</div>}
                      </td>
                      <td>
                        {a.leads?.vacante && <div style={{ fontSize: 13 }}>{a.leads.vacante}</div>}
                        {a.leads?.empresa && <div className={styles.muted} style={{ fontSize: 11 }}>{a.leads.empresa}</div>}
                      </td>
                      <td className={styles.mono}>{a.leads?.telefono || '—'}</td>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                          fontSize: 11, fontWeight: 600,
                          background: scoreBg(a.score_snapshot),
                          color: scoreFg(a.score_snapshot),
                          border: `1px solid ${scoreBorder(a.score_snapshot)}`,
                        }}>{a.score_snapshot ?? '—'} pts</span>
                      </td>
                      <td className={styles.muted} style={{ fontSize: 12 }}>
                        {tab === 'mensajes'
                          ? fmtRelative(a.leads?.created_at || null)
                          : <>
                            <div style={{ color: '#b8a3ff', fontWeight: 600 }}>{fmtDate(a.scheduled_at)}</div>
                            <div className={styles.muted} style={{ fontSize: 11 }}>{fmtFuture(a.scheduled_at)}</div>
                          </>}
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className={styles.primaryBtn}
                            style={{ padding: '6px 12px', fontSize: 12, boxShadow: 'none' }}
                            disabled={!!busy[a.id]}
                            onClick={() => approve(a.id)}>
                            {busy[a.id] === 'approve' ? '⏳…' : tab === 'mensajes' ? '📨 Mandar' : '📞 Dapta'}
                          </button>
                          <button className={styles.btnSecondary}
                            style={{ padding: '6px 12px', fontSize: 12 }}
                            disabled={!!busy[a.id]}
                            onClick={() => reject(a.id)}>
                            {busy[a.id] === 'reject' ? '⏳…' : '✋ Manual'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={styles.summaryCard}>
      <div className={styles.summaryLabel}>{label}</div>
      <div className={styles.summaryValue}>{value}</div>
      {sub && <div className={styles.summarySub}>{sub}</div>}
    </div>
  )
}

function TabChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={active ? styles.filterChipActive : styles.filterChip}>
      {label}
    </button>
  )
}

function scoreBg(s: number | null): string {
  if (s == null) return 'rgba(150,150,150,0.1)'
  if (s >= 60) return 'rgba(255,90,90,0.15)'
  if (s >= 30) return 'rgba(255,186,61,0.15)'
  return 'rgba(78,168,245,0.15)'
}
function scoreFg(s: number | null): string {
  if (s == null) return '#888'
  if (s >= 60) return '#ff5a5a'
  if (s >= 30) return '#ffba3d'
  return '#4ea8f5'
}
function scoreBorder(s: number | null): string {
  if (s == null) return 'rgba(150,150,150,0.3)'
  if (s >= 60) return 'rgba(255,90,90,0.35)'
  if (s >= 30) return 'rgba(255,186,61,0.35)'
  return 'rgba(78,168,245,0.35)'
}
