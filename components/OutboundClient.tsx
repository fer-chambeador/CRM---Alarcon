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

type ColKey = 'lead' | 'vacante' | 'telefono' | 'score' | 'edad' | 'acciones'
const DEFAULT_COL_ORDER: ColKey[] = ['lead', 'vacante', 'telefono', 'score', 'edad', 'acciones']
const COL_STORAGE_KEY = 'outbound_col_order_v1'

function loadColOrder(): ColKey[] {
  if (typeof window === 'undefined') return DEFAULT_COL_ORDER
  try {
    const raw = window.localStorage.getItem(COL_STORAGE_KEY)
    if (!raw) return DEFAULT_COL_ORDER
    const parsed = JSON.parse(raw) as string[]
    const valid = parsed.filter((k): k is ColKey => DEFAULT_COL_ORDER.includes(k as ColKey))
    // Asegurar que todas las columnas estén (por si agregamos una nueva en el futuro)
    const missing = DEFAULT_COL_ORDER.filter(k => !valid.includes(k))
    return [...valid, ...missing]
  } catch { return DEFAULT_COL_ORDER }
}
function saveColOrder(order: ColKey[]) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(order)) } catch {}
}

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
  const [colOrder, setColOrder] = useState<ColKey[]>(DEFAULT_COL_ORDER)
  useEffect(() => { setColOrder(loadColOrder()) }, [])
  const moveCol = (key: ColKey, dir: -1 | 1) => {
    setColOrder(prev => {
      const idx = prev.indexOf(key)
      if (idx < 0) return prev
      const target = idx + dir
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      saveColOrder(next)
      return next
    })
  }

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

  // ── Filtro Mensajes: excluir leads con canal_adquisicion === 'Vambe' ──
  // Por regla del user (2 jun 2026): los leads que llegan VIA Vambe ya
  // tienen su propio flujo de conversación dentro de Vambe (templates +
  // bot), no necesitan que les mandemos OTRO template outbound desde acá.
  // El outbound de aprobaciones es solo para inbound de OTROS canales
  // (Facebook, Recomendación, Calendar, Tpet, etc.) que pidan contacto
  // proactivo. Cuando el funnel de no-Vambe esté agotado, esta pestaña
  // se va a 0 — que es justamente la señal "ya está al día".
  const mensajesFiltered = useMemo(
    () => (data?.vambe || []).filter(a => a.leads?.canal_adquisicion !== 'Vambe'),
    [data],
  )

  const summary = useMemo(() => ({
    vambe: mensajesFiltered.length,
    dapta: data?.counts.dapta || 0,
    total: mensajesFiltered.length + (data?.counts.dapta || 0),
  }), [data, mensajesFiltered])

  const rows = tab === 'mensajes' ? mensajesFiltered : (data?.dapta || [])

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
                    {colOrder.map((key, idx) => (
                      <ColHeader key={key} colKey={key} idx={idx} total={colOrder.length}
                        tab={tab} onMove={moveCol} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(a => (
                    <tr key={a.id} style={{ cursor: a.leads ? 'pointer' : 'default' }}
                      onClick={() => a.leads && router.push(`/leads/${a.leads.id}`)}>
                      {colOrder.map(key => (
                        <Cell key={key} colKey={key} apro={a} tab={tab}
                          busy={busy[a.id]}
                          onApprove={() => approve(a.id)}
                          onReject={() => reject(a.id)} />
                      ))}
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

// ─── Column headers + cells (reordenables con flechas) ──────────────────
const COL_LABELS: Record<ColKey, string> = {
  lead: 'Lead',
  vacante: 'Vacante / Empresa',
  telefono: 'Teléfono',
  score: 'Score',
  edad: 'Fecha registro',
  acciones: 'Acciones',
}

function ColHeader({ colKey, idx, total, tab, onMove }: {
  colKey: ColKey
  idx: number
  total: number
  tab: Tab
  onMove: (k: ColKey, dir: -1 | 1) => void
}) {
  const isFirst = idx === 0
  const isLast = idx === total - 1
  const label = colKey === 'edad' && tab === 'llamadas' ? 'Cuándo' : COL_LABELS[colKey]
  const align = colKey === 'score' ? 'center' : 'left'
  const width = colKey === 'acciones' ? 280 : colKey === 'score' ? 90 : undefined
  return (
    <th style={{ textAlign: align, width }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <button
          disabled={isFirst}
          onClick={(e) => { e.stopPropagation(); onMove(colKey, -1) }}
          title="Mover columna a la izquierda"
          style={{
            background: 'transparent', border: 'none', color: 'var(--text3)',
            cursor: isFirst ? 'default' : 'pointer', padding: 0,
            fontSize: 11, opacity: isFirst ? 0.2 : 0.7,
          }}>◀</button>
        <span>{label}</span>
        <button
          disabled={isLast}
          onClick={(e) => { e.stopPropagation(); onMove(colKey, 1) }}
          title="Mover columna a la derecha"
          style={{
            background: 'transparent', border: 'none', color: 'var(--text3)',
            cursor: isLast ? 'default' : 'pointer', padding: 0,
            fontSize: 11, opacity: isLast ? 0.2 : 0.7,
          }}>▶</button>
      </div>
    </th>
  )
}

function Cell({ colKey, apro, tab, busy, onApprove, onReject }: {
  colKey: ColKey
  apro: Aprobacion
  tab: Tab
  busy: 'approve' | 'reject' | null | undefined
  onApprove: () => void
  onReject: () => void
}) {
  const a = apro
  if (colKey === 'lead') {
    return (
      <td>
        <div className={styles.leadName}>{a.leads?.nombre || a.leads?.email || '(sin nombre)'}</div>
        {a.leads?.email && <div className={styles.muted} style={{ fontSize: 11 }}>{a.leads.email}</div>}
      </td>
    )
  }
  if (colKey === 'vacante') {
    return (
      <td>
        {a.leads?.vacante && <div style={{ fontSize: 13 }}>{a.leads.vacante}</div>}
        {a.leads?.empresa && <div className={styles.muted} style={{ fontSize: 11 }}>{a.leads.empresa}</div>}
      </td>
    )
  }
  if (colKey === 'telefono') {
    return <td className={styles.mono}>{a.leads?.telefono || '—'}</td>
  }
  if (colKey === 'score') {
    return (
      <td style={{ textAlign: 'center' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          padding: '4px 10px', borderRadius: 999, minWidth: 56,
          fontSize: 11, fontWeight: 600,
          background: scoreBg(a.score_snapshot),
          color: scoreFg(a.score_snapshot),
          border: `1px solid ${scoreBorder(a.score_snapshot)}`,
        }}>{a.score_snapshot ?? '—'} pts</span>
      </td>
    )
  }
  if (colKey === 'edad') {
    return (
      <td className={styles.muted} style={{ fontSize: 12 }}>
        {tab === 'mensajes'
          ? <>
            <div style={{ color: 'var(--text2)' }}>{fmtDate(a.leads?.created_at || null)}</div>
            <div className={styles.muted} style={{ fontSize: 11 }}>{fmtRelative(a.leads?.created_at || null)}</div>
          </>
          : <>
            <div style={{ color: '#b8a3ff', fontWeight: 600 }}>{fmtDate(a.scheduled_at)}</div>
            <div className={styles.muted} style={{ fontSize: 11 }}>{fmtFuture(a.scheduled_at)}</div>
          </>}
      </td>
    )
  }
  // acciones
  return (
    <td onClick={e => e.stopPropagation()}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className={styles.primaryBtn}
          disabled={!!busy}
          onClick={onApprove}
          style={{
            padding: '7px 14px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            boxShadow: '0 2px 8px -2px rgba(124,84,232,0.45)',
            transition: 'transform 100ms ease, box-shadow 100ms ease, opacity 100ms ease',
            opacity: busy ? 0.6 : 1,
          }}>
          {busy === 'approve' ? '⏳ Enviando…' : tab === 'mensajes' ? '📨 Mandar' : '📞 Llamar'}
        </button>
        <button
          className={styles.btnSecondary}
          disabled={!!busy}
          onClick={onReject}
          style={{
            padding: '7px 14px',
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            opacity: busy ? 0.6 : 1,
          }}>
          {busy === 'reject' ? '⏳…' : '✋ Manual'}
        </button>
      </div>
    </td>
  )
}
