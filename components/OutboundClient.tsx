'use client'

/**
 * /outbound — Contacto masivo a leads con plantilla Vambe.
 *
 * Asistente de 3 pasos:
 *   1. Audiencia  — segmenta por status, canal (buscable), días sin contactar.
 *   2. Mensaje    — elige plantilla Vambe aprobada + stage destino.
 *   3. Revisar y enviar — resumen, velocidad de envío, Start y monitor
 *      (progreso + log + preview) mientras la tab esté abierta.
 *
 * Toda la lógica de envío se dispara vía /api/outbound/dispatch en batches.
 */

import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { Sidebar } from './CommandCenter'
import styles from './LlamadasClient.module.css'
import { STATUS_LABELS, STATUS_ORDER, statusColor } from '@/lib/status'

export type OutboundLead = {
  id: string
  nombre: string | null
  email: string | null
  telefono: string | null
  status: string
  empresa: string | null
  vacante: string | null
  canal_adquisicion: string | null
  created_at: string
  ultimo_contacto: string | null
  vambe_contact_id: string | null
  vambe_stage_id: string | null
}

export type OutboundTemplate = {
  id: string
  name: string
  preview: string
  category: string
}

type RunState = 'idle' | 'running' | 'paused' | 'done'

type LogEntry = {
  ts: number
  level: 'info' | 'ok' | 'err'
  msg: string
}

const STAGE_OPTIONS = [
  { id: '96c42cda-2828-45db-973c-3bc63a8141fd', label: 'Interesado (Asistente Agendador toma chat)' },
  { id: '05b9af0a-9bcb-4faf-a114-bdd47517a97a', label: 'Lanzamiento' },
  { id: '5847352c-f983-4e8b-b635-b19797d031a8', label: 'Contactados via WhatsApp' },
  { id: '', label: 'No mover stage (mantener actual)' },
]

const ACCENT = '#7c6af7'
const GREEN = '#22d68a'

export default function OutboundClient({
  initialLeads,
  initialTemplates,
}: {
  initialLeads: OutboundLead[]
  initialTemplates: OutboundTemplate[]
}) {
  // ── Wizard ─────────────────────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [channelSearch, setChannelSearch] = useState('')

  // ── Filtros ────────────────────────────────────────────────────────────
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set())
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set())
  const [minDaysSinceContact, setMinDaysSinceContact] = useState<number>(0)
  const [onlyWithPhone, setOnlyWithPhone] = useState(true)
  const [search, setSearch] = useState('')

  // ── Plantilla + stage ─────────────────────────────────────────────────
  const [templateId, setTemplateId] = useState<string>('')
  const [stageId, setStageId] = useState<string>(STAGE_OPTIONS[0].id)

  // ── Batches ────────────────────────────────────────────────────────────
  const [batchSize, setBatchSize] = useState(10)
  const [intervalMin, setIntervalMin] = useState(5)

  // ── Runtime ────────────────────────────────────────────────────────────
  const [runState, setRunState] = useState<RunState>('idle')
  const [sentIds, setSentIds] = useState<Set<string>>(new Set())
  const [failedIds, setFailedIds] = useState<Map<string, string>>(new Map())
  const [currentBatch, setCurrentBatch] = useState(0)
  const [log, setLog] = useState<LogEntry[]>([])
  const [nextBatchAt, setNextBatchAt] = useState<number | null>(null)
  const stopRequested = useRef(false)

  const running = runState === 'running'

  // ── Counts por status ─────────────────────────────────────────────────
  const statusCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of initialLeads) {
      if (onlyWithPhone && !l.telefono) continue
      map.set(l.status, (map.get(l.status) || 0) + 1)
    }
    return map
  }, [initialLeads, onlyWithPhone])

  // ── Counts por canal ──────────────────────────────────────────────────
  const channelCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of initialLeads) {
      if (onlyWithPhone && !l.telefono) continue
      const c = l.canal_adquisicion?.trim() || '(sin canal)'
      map.set(c, (map.get(c) || 0) + 1)
    }
    return map
  }, [initialLeads, onlyWithPhone])

  const allChannels = useMemo(
    () => Array.from(channelCounts.keys()).sort((a, b) => (channelCounts.get(b) || 0) - (channelCounts.get(a) || 0)),
    [channelCounts],
  )

  // Canal compacto: seleccionados siempre + resto filtrado por búsqueda (top 10 si no hay búsqueda)
  const channelView = useMemo(() => {
    const q = channelSearch.trim().toLowerCase()
    const sel = allChannels.filter((c) => selectedChannels.has(c))
    const restAll = allChannels.filter((c) => !selectedChannels.has(c) && (!q || c.toLowerCase().includes(q)))
    const rest = q ? restAll : restAll.slice(0, 10)
    return { sel, rest, hidden: restAll.length - rest.length }
  }, [allChannels, channelSearch, selectedChannels])

  // ── Lista filtrada ─────────────────────────────────────────────────────
  const filteredLeads = useMemo(() => {
    const now = Date.now()
    const q = search.trim().toLowerCase()
    return initialLeads.filter((l) => {
      if (selectedStatuses.size > 0 && !selectedStatuses.has(l.status)) return false
      if (selectedChannels.size > 0) {
        const c = l.canal_adquisicion?.trim() || '(sin canal)'
        if (!selectedChannels.has(c)) return false
      }
      if (onlyWithPhone && !l.telefono) return false
      if (minDaysSinceContact > 0 && l.ultimo_contacto) {
        const days = (now - new Date(l.ultimo_contacto).getTime()) / 86400_000
        if (days < minDaysSinceContact) return false
      }
      if (q) {
        const hay = `${l.nombre || ''} ${l.email || ''} ${l.empresa || ''} ${l.telefono || ''} ${l.vacante || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [initialLeads, selectedStatuses, selectedChannels, onlyWithPhone, minDaysSinceContact, search])

  const remaining = useMemo(
    () => filteredLeads.filter((l) => !sentIds.has(l.id) && !failedIds.has(l.id)),
    [filteredLeads, sentIds, failedIds],
  )

  const totalToSend = filteredLeads.length
  const sentCount = sentIds.size
  const failedCount = failedIds.size
  const progressPct = totalToSend > 0 ? Math.floor(((sentCount + failedCount) / totalToSend) * 100) : 0

  const selectedTemplate = initialTemplates.find((t) => t.id === templateId) || null
  const selectedStage = STAGE_OPTIONS.find((s) => s.id === stageId) || STAGE_OPTIONS[0]

  // ── Toggle helpers ────────────────────────────────────────────────────
  const toggleStatus = (s: string) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }
  const toggleChannel = (c: string) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }
  const DAYS_PRESETS: { label: string; value: number }[] = [
    { label: 'Sin filtro', value: 0 },
    { label: '≥ 3 días', value: 3 },
    { label: '≥ 7 días', value: 7 },
    { label: '≥ 14 días', value: 14 },
    { label: '≥ 30 días', value: 30 },
  ]

  // ── Dispatcher ─────────────────────────────────────────────────────────
  const appendLog = useCallback((e: Omit<LogEntry, 'ts'>) => {
    setLog((prev) => [{ ts: Date.now(), ...e }, ...prev].slice(0, 200))
  }, [])

  const sendOneBatch = useCallback(async (leads: OutboundLead[]): Promise<{ ok: number; err: number }> => {
    if (leads.length === 0) return { ok: 0, err: 0 }
    const phones = leads.map((l) => ({ id: l.id, phone: l.telefono })).filter((p) => p.phone)
    try {
      const res = await fetch('/api/outbound/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateId, stageId, leads: phones }),
      })
      const data = await res.json() as {
        results?: { id: string; ok: boolean; error?: string }[]
        error?: string
      }
      if (!res.ok || !data.results) {
        appendLog({ level: 'err', msg: `Batch falló: ${data.error || res.status}` })
        const errMap = new Map(failedIds)
        for (const l of leads) errMap.set(l.id, data.error || `HTTP ${res.status}`)
        setFailedIds(errMap)
        return { ok: 0, err: leads.length }
      }
      let okCount = 0
      let errCount = 0
      setSentIds((prev) => {
        const next = new Set(prev)
        for (const r of data.results || []) {
          if (r.ok) {
            next.add(r.id)
            okCount++
          }
        }
        return next
      })
      setFailedIds((prev) => {
        const next = new Map(prev)
        for (const r of data.results || []) {
          if (!r.ok) {
            next.set(r.id, r.error || 'unknown')
            errCount++
          }
        }
        return next
      })
      return { ok: okCount, err: errCount }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendLog({ level: 'err', msg: `Network error: ${msg}` })
      return { ok: 0, err: leads.length }
    }
  }, [templateId, stageId, failedIds, appendLog])

  // ── Loop principal ────────────────────────────────────────────────────
  const runLoop = useCallback(async () => {
    stopRequested.current = false
    setRunState('running')
    setCurrentBatch(0)
    let batchNum = 0
    while (!stopRequested.current) {
      const pendingLeads = filteredLeads.filter((l) => !sentIds.has(l.id) && !failedIds.has(l.id))
      if (pendingLeads.length === 0) {
        appendLog({ level: 'ok', msg: '✅ Campaña completa.' })
        setRunState('done')
        setNextBatchAt(null)
        return
      }
      const batch = pendingLeads.slice(0, batchSize)
      batchNum++
      setCurrentBatch(batchNum)
      appendLog({ level: 'info', msg: `📦 Batch #${batchNum}: enviando ${batch.length} leads…` })
      const { ok, err } = await sendOneBatch(batch)
      appendLog({ level: ok > 0 ? 'ok' : 'err', msg: `Batch #${batchNum}: ${ok} OK, ${err} fallidos.` })

      const stillRemaining = filteredLeads.filter((l) => !sentIds.has(l.id) && !failedIds.has(l.id) && !batch.some((b) => b.id === l.id)).length
      if (stillRemaining === 0) {
        appendLog({ level: 'ok', msg: '✅ Campaña completa.' })
        setRunState('done')
        setNextBatchAt(null)
        return
      }

      const waitMs = intervalMin * 60 * 1000
      const until = Date.now() + waitMs
      setNextBatchAt(until)
      appendLog({ level: 'info', msg: `⏳ Esperando ${intervalMin} min al siguiente batch…` })
      while (Date.now() < until) {
        if (stopRequested.current) {
          appendLog({ level: 'info', msg: '⏸ Pausado por usuario.' })
          setRunState('paused')
          setNextBatchAt(null)
          return
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }, [filteredLeads, sentIds, failedIds, batchSize, intervalMin, sendOneBatch, appendLog])

  const handleStart = () => {
    if (!templateId) {
      alert('Elige una plantilla primero.')
      return
    }
    if (filteredLeads.length === 0) {
      alert('No hay leads que coincidan con el filtro.')
      return
    }
    if (!confirm(`¿Empezar campaña? Se enviará la plantilla a ${remaining.length} leads en batches de ${batchSize} cada ${intervalMin} min.\n\nNo cierres esta pestaña hasta que termine.`)) {
      return
    }
    appendLog({ level: 'info', msg: `🚀 Iniciando: ${remaining.length} leads, batch=${batchSize}, intervalo=${intervalMin}min` })
    void runLoop()
  }

  const handlePause = () => {
    stopRequested.current = true
  }

  const handleResume = () => {
    void runLoop()
  }

  const handleReset = () => {
    if (!confirm('¿Resetear el progreso? (no afecta los mensajes ya enviados)')) return
    setSentIds(new Set())
    setFailedIds(new Map())
    setCurrentBatch(0)
    setLog([])
    setRunState('idle')
    setNextBatchAt(null)
  }

  // ── Countdown UI ──────────────────────────────────────────────────────
  const [countdown, setCountdown] = useState<string>('')
  useEffect(() => {
    if (!nextBatchAt) return
    const i = setInterval(() => {
      const ms = nextBatchAt - Date.now()
      if (ms <= 0) { setCountdown('disparando…'); return }
      const s = Math.floor(ms / 1000)
      const m = Math.floor(s / 60)
      setCountdown(`${m}m ${s % 60}s`)
    }, 500)
    return () => clearInterval(i)
  }, [nextBatchAt])

  // ── UI ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="aprobaciones" />
      </aside>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <h1>📨 Outbound masivo</h1>
          <span className={styles.topBarSpacer} />
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            {initialLeads.length.toLocaleString('es-MX')} leads en BD · {initialTemplates.length} plantillas aprobadas
          </span>
        </div>

        <div className={styles.body} style={{ maxWidth: 900, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Stepper */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StepPill n={1} label="Audiencia" active={step === 1} done={step > 1} onClick={() => !running && setStep(1)} />
            <span style={{ color: 'var(--text3)' }}>›</span>
            <StepPill n={2} label="Mensaje" active={step === 2} done={step > 2} onClick={() => !running && totalToSend > 0 && setStep(2)} />
            <span style={{ color: 'var(--text3)' }}>›</span>
            <StepPill n={3} label="Revisar y enviar" active={step === 3} done={false} onClick={() => !running && totalToSend > 0 && templateId && setStep(3)} />
          </div>

          {/* ══ PASO 1 · AUDIENCIA ══ */}
          {step === 1 && (
            <Card title="¿A quién le enviamos?">
              {/* Status */}
              <div style={labelStyle}>Status del lead</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {STATUS_ORDER.map((s) => {
                  const count = statusCounts.get(s) || 0
                  const sel = selectedStatuses.has(s)
                  return (
                    <button key={s} onClick={() => toggleStatus(s)}
                      style={chip(sel, statusColor(s as never), count === 0)}>
                      {STATUS_LABELS[s]} <span style={{ color: 'var(--text3)' }}>({count})</span>
                    </button>
                  )
                })}
              </div>
              <div style={hintStyle}>Sin seleccionar = todos los status.</div>

              {/* Canal — buscable */}
              <div style={{ ...labelStyle, marginTop: 18 }}>
                Canal {selectedChannels.size > 0 && <span style={{ color: 'var(--text2)' }}>· {selectedChannels.size} elegido{selectedChannels.size === 1 ? '' : 's'}</span>}
              </div>
              {channelView.sel.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {channelView.sel.map((c) => (
                    <button key={c} onClick={() => toggleChannel(c)} style={chip(true, ACCENT, false)}>
                      {c} <span style={{ opacity: 0.7 }}>✕</span>
                    </button>
                  ))}
                </div>
              )}
              <input type="text" placeholder={`Buscar entre ${allChannels.length} canales…`}
                value={channelSearch} onChange={(e) => setChannelSearch(e.target.value)}
                style={inputStyle} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {channelView.rest.length === 0 && (
                  <span style={{ fontSize: 12, color: 'var(--text3)', fontStyle: 'italic' }}>Sin coincidencias</span>
                )}
                {channelView.rest.map((c) => (
                  <button key={c} onClick={() => toggleChannel(c)} style={chip(false, ACCENT, (channelCounts.get(c) || 0) === 0)}>
                    {c} <span style={{ color: 'var(--text3)' }}>({channelCounts.get(c) || 0})</span>
                  </button>
                ))}
                {channelView.hidden > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'center' }}>+{channelView.hidden} más — busca arriba</span>
                )}
              </div>

              {/* Días sin contactar */}
              <div style={{ ...labelStyle, marginTop: 18 }}>Días sin contactar</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {DAYS_PRESETS.map((p) => (
                  <button key={p.value} onClick={() => setMinDaysSinceContact(p.value)}
                    style={chip(minDaysSinceContact === p.value, GREEN, false)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={hintStyle}>Leads sin contacto previo siempre pasan.</div>

              {/* Otros */}
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 12.5, color: 'var(--text2)', marginTop: 16 }}>
                <input type="checkbox" checked={onlyWithPhone} onChange={(e) => setOnlyWithPhone(e.target.checked)} />
                Solo leads con teléfono
              </label>
              <input type="text" placeholder="Buscar por nombre, email, empresa, tel…"
                value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...inputStyle, marginTop: 12 }} />

              {/* Contador + nav */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 30, fontWeight: 800, color: ACCENT, fontVariantNumeric: 'tabular-nums' }}>{totalToSend.toLocaleString('es-MX')}</span>
                  <span style={{ fontSize: 13, color: 'var(--text2)' }}>leads en este segmento</span>
                </div>
                <button className={styles.primaryBtn} onClick={() => setStep(2)} disabled={totalToSend === 0}
                  style={{ padding: '11px 20px', fontSize: 14, fontWeight: 700, opacity: totalToSend === 0 ? 0.5 : 1 }}>
                  Siguiente: mensaje →
                </button>
              </div>
            </Card>
          )}

          {/* ══ PASO 2 · MENSAJE ══ */}
          {step === 2 && (
            <Card title={`¿Qué mensaje enviamos? (${initialTemplates.length} plantillas)`}>
              {initialTemplates.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--text3)' }}>
                  No se pudo cargar plantillas. Pega el ID manualmente:
                  <input type="text" placeholder="Template ID UUID" value={templateId}
                    onChange={(e) => setTemplateId(e.target.value.trim())} style={{ ...inputStyle, marginTop: 8 }} />
                </div>
              )}
              {initialTemplates.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10, maxHeight: 420, overflowY: 'auto', padding: 2 }}>
                  {initialTemplates.map((t) => {
                    const sel = templateId === t.id
                    return (
                      <button key={t.id} onClick={() => setTemplateId(t.id)}
                        style={{
                          textAlign: 'left', padding: 12, borderRadius: 10,
                          border: `2px solid ${sel ? ACCENT : 'var(--border)'}`,
                          background: sel ? 'rgba(124,106,247,0.12)' : 'rgba(255,255,255,0.02)',
                          cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 110,
                        }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', wordBreak: 'break-word' }}>{t.name}</span>
                          {t.category && (
                            <span style={{ fontSize: 9.5, padding: '2px 6px', borderRadius: 999, background: 'rgba(255,255,255,0.08)', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{t.category}</span>
                          )}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text2)', whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4, flex: 1 }}>
                          {t.preview || <em style={{ color: 'var(--text3)' }}>(sin preview)</em>}
                        </div>
                        {sel && <div style={{ fontSize: 10.5, color: ACCENT, fontWeight: 700 }}>✓ Seleccionada</div>}
                      </button>
                    )
                  })}
                </div>
              )}

              <div style={{ ...labelStyle, marginTop: 16 }}>Stage destino al enviar</div>
              <select value={stageId} onChange={(e) => setStageId(e.target.value)} style={{ ...inputStyle, marginTop: 0 }}>
                {STAGE_OPTIONS.map((s) => (
                  <option key={s.id || 'none'} value={s.id}>{s.label}</option>
                ))}
              </select>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)', gap: 12 }}>
                <button onClick={() => setStep(1)} style={backBtn}>← Audiencia</button>
                <button className={styles.primaryBtn} onClick={() => setStep(3)} disabled={!templateId}
                  style={{ padding: '11px 20px', fontSize: 14, fontWeight: 700, opacity: !templateId ? 0.5 : 1 }}>
                  Siguiente: revisar →
                </button>
              </div>
            </Card>
          )}

          {/* ══ PASO 3 · REVISAR Y ENVIAR ══ */}
          {step === 3 && (
            <>
              <Card title="Revisar y enviar">
                {/* Resumen */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
                  <SummaryItem label="Audiencia" value={`${totalToSend.toLocaleString('es-MX')} leads`} />
                  <SummaryItem label="Plantilla" value={selectedTemplate?.name || '—'} />
                  <SummaryItem label="Stage destino" value={selectedStage.label.split(' (')[0]} />
                </div>

                {/* Velocidad */}
                <div style={labelStyle}>Velocidad de envío</div>
                <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
                  <label style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>Leads por batch</div>
                    <input type="number" min={1} max={500} value={batchSize} disabled={running}
                      onChange={(e) => setBatchSize(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                      style={{ ...inputStyle, marginTop: 0 }} />
                  </label>
                  <label style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>Minutos entre batches</div>
                    <input type="number" min={0} max={60} value={intervalMin} disabled={running}
                      onChange={(e) => setIntervalMin(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                      style={{ ...inputStyle, marginTop: 0 }} />
                  </label>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 10 }}>
                  {totalToSend > 0 && batchSize > 0 && (
                    <>
                      <strong>{Math.ceil(totalToSend / batchSize)}</strong> batch(es) · duración estimada{' '}
                      <strong>~{Math.max(1, Math.ceil(totalToSend / batchSize) - 1) * intervalMin} min</strong>
                    </>
                  )}
                </div>

                {/* Acciones */}
                <div style={{ marginTop: 18 }}>
                  {runState === 'idle' && (
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <button onClick={() => setStep(2)} style={backBtn}>← Mensaje</button>
                      <button className={styles.primaryBtn} onClick={handleStart} disabled={!templateId || totalToSend === 0}
                        style={{ flex: 1, minWidth: 200, padding: '13px', fontSize: 15, fontWeight: 800 }}>
                        🚀 Empezar campaña ({remaining.length.toLocaleString('es-MX')} leads)
                      </button>
                    </div>
                  )}
                  {runState === 'running' && (
                    <button onClick={handlePause} style={{ width: '100%', padding: '13px', fontSize: 15, fontWeight: 700, borderRadius: 8, background: '#ffba3d', color: '#000', border: 'none', cursor: 'pointer' }}>
                      ⏸ Pausar
                    </button>
                  )}
                  {runState === 'paused' && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={handleResume} style={{ flex: 1, padding: '13px', fontSize: 15, fontWeight: 700, borderRadius: 8, background: GREEN, color: '#000', border: 'none', cursor: 'pointer' }}>
                        ▶ Reanudar ({remaining.length.toLocaleString('es-MX')} restantes)
                      </button>
                      <button onClick={handleReset} style={{ padding: '13px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: 'transparent', color: 'var(--text2)', border: '1px solid var(--border)', cursor: 'pointer' }}>Reset</button>
                    </div>
                  )}
                  {runState === 'done' && (
                    <div>
                      <div style={{ padding: 12, borderRadius: 8, background: 'rgba(34,214,138,0.1)', color: GREEN, fontSize: 14, fontWeight: 600, textAlign: 'center', marginBottom: 8 }}>
                        ✅ Completado — {sentCount} OK, {failedCount} fallidos
                      </div>
                      <button onClick={handleReset} style={{ width: '100%', padding: '10px', fontSize: 12, fontWeight: 600, borderRadius: 8, background: 'transparent', color: 'var(--text2)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                        Reset para otra campaña
                      </button>
                    </div>
                  )}
                </div>
              </Card>

              {/* Progreso */}
              <Card title="Progreso">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
                  <Metric label="Total" value={totalToSend} />
                  <Metric label="Enviados" value={sentCount} color={GREEN} />
                  <Metric label="Fallidos" value={failedCount} color="#f05a5a" />
                  <Metric label="Restantes" value={remaining.length} color="#4ea8f5" />
                </div>
                <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${progressPct}%`, background: 'linear-gradient(90deg, #22d68a, #4ea8f5)', transition: 'width 300ms ease' }} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{progressPct}% completado</span>
                  {nextBatchAt && <span>Próximo batch: {countdown}</span>}
                  {running && currentBatch > 0 && <span>Batch actual: #{currentBatch}</span>}
                </div>
              </Card>

              {/* Log */}
              <Card title="Log de actividad">
                {log.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center', padding: 20 }}>
                    Sin actividad todavía. Dale a empezar campaña.
                  </div>
                ) : (
                  <div style={{ maxHeight: 240, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {log.map((l, i) => (
                      <div key={i} style={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', color: l.level === 'err' ? '#f05a5a' : l.level === 'ok' ? GREEN : 'var(--text2)', borderLeft: `2px solid ${l.level === 'err' ? '#f05a5a' : l.level === 'ok' ? GREEN : 'var(--text3)'}`, paddingLeft: 8 }}>
                        <span style={{ color: 'var(--text3)' }}>{new Date(l.ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                        {' '}{l.msg}
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {/* Preview */}
              <Card title={`A quién le llega (${filteredLeads.length.toLocaleString('es-MX')})`}>
                {filteredLeads.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center', padding: 20 }}>Ningún lead coincide con el filtro.</div>
                ) : (
                  <div style={{ maxHeight: 300, overflow: 'auto' }}>
                    <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ position: 'sticky', top: 0, background: 'var(--bg, #0e0e15)' }}>
                          <th style={thStyle}>Lead</th>
                          <th style={thStyle}>Tel</th>
                          <th style={thStyle}>Status</th>
                          <th style={{ ...thStyle, textAlign: 'center' }}>—</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredLeads.slice(0, 200).map((l) => {
                          const sent = sentIds.has(l.id)
                          const failed = failedIds.has(l.id)
                          return (
                            <tr key={l.id} style={{ borderBottom: '1px solid var(--border)', opacity: sent ? 0.4 : 1 }}>
                              <td style={{ padding: '6px 4px', color: 'var(--text2)' }}>
                                {l.nombre || l.email || '(sin nombre)'}
                                {l.empresa && <span style={{ color: 'var(--text3)' }}> · {l.empresa}</span>}
                              </td>
                              <td style={{ padding: '6px 4px', color: 'var(--text3)', fontFamily: 'ui-monospace, monospace' }}>{l.telefono || '—'}</td>
                              <td style={{ padding: '6px 4px' }}>
                                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: statusColor(l.status as never) + '22', color: statusColor(l.status as never) }}>
                                  {STATUS_LABELS[l.status as keyof typeof STATUS_LABELS] || l.status}
                                </span>
                              </td>
                              <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                                {sent && <span style={{ color: GREEN }}>✓</span>}
                                {failed && <span style={{ color: '#f05a5a' }} title={failedIds.get(l.id)}>✗</span>}
                              </td>
                            </tr>
                          )
                        })}
                        {filteredLeads.length > 200 && (
                          <tr><td colSpan={4} style={{ padding: 8, textAlign: 'center', color: 'var(--text3)', fontSize: 11 }}>+{filteredLeads.length - 200} más…</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

// ── Estilos compartidos ────────────────────────────────────────────────
const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }
const hintStyle: React.CSSProperties = { fontSize: 10.5, color: 'var(--text3)', marginTop: 6, fontStyle: 'italic' }
const inputStyle: React.CSSProperties = { width: '100%', padding: '9px 12px', marginTop: 4, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, transparent)', color: 'var(--text)', fontSize: 13 }
const thStyle: React.CSSProperties = { textAlign: 'left', padding: '6px 4px', color: 'var(--text3)', fontWeight: 600, fontSize: 10 }
const backBtn: React.CSSProperties = { padding: '11px 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: 'transparent', color: 'var(--text2)', border: '1px solid var(--border)', cursor: 'pointer' }

function chip(sel: boolean, color: string, dim: boolean): React.CSSProperties {
  return {
    padding: '6px 11px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: `1px solid ${sel ? color : 'var(--border)'}`,
    background: sel ? color + '22' : 'transparent',
    color: sel ? 'var(--text)' : 'var(--text2)',
    cursor: 'pointer',
    opacity: dim ? 0.4 : 1,
  }
}

function StepPill({ n, label, active, done, onClick }: { n: number; label: string; active: boolean; done: boolean; onClick: () => void }) {
  const on = active || done
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 999,
      border: `1px solid ${active ? ACCENT : 'var(--border)'}`,
      background: active ? 'rgba(124,106,247,0.14)' : 'transparent',
      color: on ? 'var(--text)' : 'var(--text3)', cursor: 'pointer', fontSize: 13, fontWeight: 600,
    }}>
      <span style={{
        width: 20, height: 20, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, background: on ? ACCENT : 'var(--border)', color: on ? '#fff' : 'var(--text3)',
      }}>{done ? '✓' : n}</span>
      {label}
    </button>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 10.5, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600, marginTop: 3, wordBreak: 'break-word' }}>{value}</div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: 18, borderRadius: 14, background: 'var(--glass)', border: '1px solid var(--border)' }}>
      <h3 style={{ margin: 0, marginBottom: 12, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{title}</h3>
      {children}
    </section>
  )
}

function Metric({ label, value, color = 'var(--text)' }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value.toLocaleString('es-MX')}</div>
    </div>
  )
}
