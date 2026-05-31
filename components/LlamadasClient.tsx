'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { Sidebar } from './CommandCenter'
import styles from './LlamadasClient.module.css'

type LeadJoined = {
  id: string
  nombre: string | null
  email: string | null
  empresa: string | null
  telefono: string | null
  status: string
  presupuesto: string | null
  vacante: string | null
}

type Llamada = {
  id: string
  lead_id: string | null
  dapta_call_id: string | null
  agent_name: string | null
  status: 'queued' | 'dialing' | 'connected' | 'completed' | 'failed' | 'no_answer' | 'voicemail' | 'canceled'
  outcome: string | null
  to_number: string
  from_number: string | null
  duration_seconds: number | null
  recording_url: string | null
  summary: string | null
  sentimiento: string | null
  interes_real: string | null
  pidio_link_pago: boolean
  pidio_presentacion: boolean
  agendar_seguimiento: string | null
  triggered_by: string | null
  trigger_reason: string | null
  error_message: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  leads: LeadJoined | null
}

type LeadOption = {
  id: string
  nombre: string | null
  email: string
  empresa: string | null
  telefono: string | null
  status: string
}

const STATUS_LABEL: Record<Llamada['status'], string> = {
  queued: 'En cola',
  dialing: 'Marcando',
  connected: 'En curso',
  completed: 'Completada',
  failed: 'Falló',
  no_answer: 'No contestó',
  voicemail: 'Buzón',
  canceled: 'Cancelada',
}

const STATUS_CLASS: Record<Llamada['status'], string> = {
  queued: styles.statusQueued,
  dialing: styles.statusDialing,
  connected: styles.statusConnected,
  completed: styles.statusCompleted,
  failed: styles.statusFailed,
  no_answer: styles.statusNoAnswer,
  voicemail: styles.statusVoicemail,
  canceled: styles.statusCanceled,
}

const OUTCOME_LABEL: Record<string, string> = {
  pidio_link_pago: '💰 Liga de pago',
  pidio_presentacion: '📋 Presentación',
  no_interesado: '🚫 No interesado',
  callback: '⏰ Callback',
  buzon_voz: '📬 Buzón',
  numero_equivocado: '❓ Núm. equivocado',
  otro: '· Otro',
}
const OUTCOME_CLASS: Record<string, string> = {
  pidio_link_pago: styles.outcomePidioLinkPago,
  pidio_presentacion: styles.outcomePidioPresentacion,
  no_interesado: styles.outcomeNoInteresado,
  callback: styles.outcomeCallback,
  buzon_voz: styles.outcomeBuzonVoz,
  numero_equivocado: styles.outcomeNumeroEquivocado,
  otro: styles.outcomeOtro,
}

function fmtDuration(seconds: number | null): string {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function fmtDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function LlamadasClient() {
  const router = useRouter()
  const [llamadas, setLlamadas] = useState<Llamada[]>([])
  const [loading, setLoading] = useState(false)
  const [filterStatus, setFilterStatus] = useState<string>('todos')
  const [filterOutcome, setFilterOutcome] = useState<string>('todos')
  const [showModal, setShowModal] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (filterStatus !== 'todos') params.set('status', filterStatus)
      if (filterOutcome !== 'todos') params.set('outcome', filterOutcome)
      const res = await fetch(`/api/llamadas?${params}`, { cache: 'no-store' })
      const json = await res.json()
      setLlamadas(json.llamadas || [])
    } finally {
      setLoading(false)
    }
  }, [filterStatus, filterOutcome])

  useEffect(() => { load() }, [load])

  const summary = useMemo(() => {
    const completed = llamadas.filter(l => l.status === 'completed').length
    const ligaPago = llamadas.filter(l => l.pidio_link_pago).length
    const presentacion = llamadas.filter(l => l.pidio_presentacion).length
    const noAnswer = llamadas.filter(l => l.status === 'no_answer' || l.status === 'voicemail').length
    return { total: llamadas.length, completed, ligaPago, presentacion, noAnswer }
  }, [llamadas])

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="llamadas" />
      </aside>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <h1>☎️ Llamadas</h1>
          <span className={styles.topBarSpacer} />
          <button className={styles.refreshBtn} onClick={load} disabled={loading}>
            {loading ? 'Cargando…' : '↻ Refresh'}
          </button>
          <button className={styles.primaryBtn} onClick={() => setShowModal(true)}>
            + Disparar llamada
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.summary}>
            <Card label="Total" value={summary.total.toLocaleString('es-MX')} />
            <Card label="Completadas" value={summary.completed.toLocaleString('es-MX')} sub="con análisis post-call" />
            <Card label="💰 Pidió pago" value={summary.ligaPago.toLocaleString('es-MX')} sub="cierres en caliente" />
            <Card label="📋 Pidió pres." value={summary.presentacion.toLocaleString('es-MX')} sub="follow-up con propuesta" />
          </div>

          <div className={styles.filterBar}>
            <FilterChip label="Todos los status" active={filterStatus === 'todos'} onClick={() => setFilterStatus('todos')} />
            {(['completed', 'connected', 'queued', 'no_answer', 'voicemail', 'failed'] as const).map(s => (
              <FilterChip key={s} label={STATUS_LABEL[s]} active={filterStatus === s} onClick={() => setFilterStatus(s)} />
            ))}
            <span style={{ width: 12 }} />
            <FilterChip label="Cualquier outcome" active={filterOutcome === 'todos'} onClick={() => setFilterOutcome('todos')} />
            <FilterChip label="💰 Liga pago" active={filterOutcome === 'pidio_link_pago'} onClick={() => setFilterOutcome('pidio_link_pago')} />
            <FilterChip label="📋 Presentación" active={filterOutcome === 'pidio_presentacion'} onClick={() => setFilterOutcome('pidio_presentacion')} />
            <FilterChip label="⏰ Callback" active={filterOutcome === 'callback'} onClick={() => setFilterOutcome('callback')} />
            <FilterChip label="🚫 No interesado" active={filterOutcome === 'no_interesado'} onClick={() => setFilterOutcome('no_interesado')} />
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Fecha</th>
                  <th>Teléfono</th>
                  <th>Status</th>
                  <th>Outcome</th>
                  <th>Interés</th>
                  <th>Duración</th>
                  <th>Resumen</th>
                  <th>Próximo paso</th>
                </tr>
              </thead>
              <tbody>
                {llamadas.length === 0 ? (
                  <tr><td colSpan={9} className={styles.empty}>
                    {loading ? 'Cargando llamadas…' : 'Sin llamadas todavía. Dispará la primera con el botón de arriba.'}
                  </td></tr>
                ) : (
                  llamadas.map(l => <Row key={l.id} l={l} onClick={() => router.push(`/llamadas/${l.id}`)} />)
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {showModal && <TriggerCallModal onClose={() => setShowModal(false)} onTriggered={() => { setShowModal(false); load() }} />}
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

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={clsx(styles.filterChip, active && styles.filterChipActive)} onClick={onClick}>{label}</button>
  )
}

function Row({ l, onClick }: { l: Llamada; onClick: () => void }) {
  const interesClass = l.interes_real === 'alto' ? styles.interesAlto
    : l.interes_real === 'medio' ? styles.interesMedio
    : l.interes_real === 'bajo' ? styles.interesBajo : ''
  return (
    <tr onClick={onClick} className={styles.row}>
      <td data-label="Lead" className={styles.leadCell}>
        <div className={styles.leadName}>{l.leads?.nombre || l.leads?.email || '—'}</div>
        {l.leads?.empresa && <div className={styles.muted}>{l.leads.empresa}</div>}
      </td>
      <td data-label="Fecha" className={styles.muted}>{fmtDate(l.started_at || l.created_at)}</td>
      <td data-label="Teléfono" className={styles.mono}>{l.to_number}</td>
      <td data-label="Status"><span className={clsx(styles.statusChip, STATUS_CLASS[l.status])}>{STATUS_LABEL[l.status]}</span></td>
      <td data-label="Outcome">
        {l.outcome ? <span className={clsx(styles.outcomeChip, OUTCOME_CLASS[l.outcome] || styles.outcomeOtro)}>{OUTCOME_LABEL[l.outcome] || l.outcome}</span> : <span className={styles.muted}>—</span>}
      </td>
      <td data-label="Interés">
        {l.interes_real ? <span className={interesClass}>{l.interes_real}</span> : <span className={styles.muted}>—</span>}
      </td>
      <td data-label="Duración" className={styles.mono}>{fmtDuration(l.duration_seconds)}</td>
      <td data-label="Resumen" className={styles.summaryCell} style={{ maxWidth: 360, fontSize: 12, lineHeight: 1.45 }}>{l.summary ? l.summary.slice(0, 140) + (l.summary.length > 140 ? '…' : '') : <span className={styles.muted}>—</span>}</td>
      <td data-label="Próximo paso" className={styles.nextStepCell} style={{ maxWidth: 240, fontSize: 12 }}>{(l as unknown as { custom_analysis?: { proximo_paso?: string } }).custom_analysis?.proximo_paso || <span className={styles.muted}>—</span>}</td>
    </tr>
  )
}

// ─── Modal ───────────────────────────────────────────────────────────────
function TriggerCallModal({ onClose, onTriggered }: { onClose: () => void; onTriggered: () => void }) {
  const [search, setSearch] = useState('')
  const [leads, setLeads] = useState<LeadOption[]>([])
  const [selected, setSelected] = useState<LeadOption | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancel = false
    async function run() {
      if (search.trim().length < 2) { setLeads([]); return }
      try {
        const res = await fetch(`/api/leads/search?q=${encodeURIComponent(search)}&limit=10`, { cache: 'no-store' })
        if (res.ok) {
          const j = await res.json()
          if (!cancel) setLeads((j.leads || j || []).slice(0, 10))
        }
      } catch { /* ignore */ }
    }
    const t = setTimeout(run, 250)
    return () => { cancel = true; clearTimeout(t) }
  }, [search])

  async function trigger() {
    if (!selected) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/dapta/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lead_id: selected.id, trigger_reason: 'manual' }),
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        setError(j.error || j.dapta?.error || `Error HTTP ${res.status}`)
      } else {
        onTriggered()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>📞 Disparar llamada Dapta</h2>
        <p className={styles.modalSub}>Buscá el lead por nombre, email o empresa. Daniela lo llamará en segundos.</p>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>Lead</label>
          <input
            className={styles.formInput}
            type="text"
            placeholder="Buscar lead…"
            value={search}
            onChange={e => { setSearch(e.target.value); setSelected(null) }}
            autoFocus
          />
          {leads.length > 0 && !selected && (
            <div className={styles.leadOptionList}>
              {leads.map(l => (
                <div key={l.id} className={styles.leadOption} onClick={() => { setSelected(l); setSearch(l.nombre || l.email) }}>
                  <div style={{ fontWeight: 500 }}>{l.nombre || l.email}</div>
                  <div className={styles.muted}>{l.empresa || '—'} · {l.telefono || 'sin teléfono'}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>Llamada a disparar</label>
            <div style={{ background: 'var(--glass)', padding: '12px 16px', borderRadius: 10, border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600 }}>{selected.nombre || selected.email}</div>
              <div className={styles.muted}>{selected.empresa || '—'}</div>
              <div className={styles.mono} style={{ marginTop: 6 }}>{selected.telefono || '⚠️ Sin teléfono — no se puede llamar'}</div>
            </div>
          </div>
        )}

        <div className={styles.modalActions}>
          <button className={styles.btnSecondary} onClick={onClose} disabled={submitting}>Cancelar</button>
          <button className={styles.primaryBtn} onClick={trigger} disabled={!selected || !selected.telefono || submitting}>
            {submitting ? 'Disparando…' : '📞 Llamar ahora'}
          </button>
        </div>
      </div>
    </div>
  )
}
