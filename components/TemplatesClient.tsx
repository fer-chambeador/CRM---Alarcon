'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from './CommandCenter'
import styles from './TemplatesClient.module.css'

type Template = {
  id: string
  name?: string
  status?: string
  category?: string
  language?: string
  channel_type?: string
  body?: string
  components?: unknown
  [k: string]: unknown
}

type SegmentFilter = {
  status?: string[]
  canal_adquisicion?: string[]
  vacante?: string
  presupuesto?: string[]
  diasSinContactarMin?: number
  diasSinContactarMax?: number
}

type Campaign = {
  id: string
  template_id: string
  template_name: string | null
  template_body: string | null
  segment: SegmentFilter | null
  total_targeted: number
  total_sent: number
  total_failed: number
  source: string
  created_at: string
  metrics: {
    sent: number
    failed: number
    responded: number
    scheduled: number
    paid: number
    responded_rate: number
    scheduled_rate: number
    paid_rate: number
  }
}

type Preview = {
  total: number
  sendable: number
  skipped: number
  matched_leads?: number
  source?: string
  recipients?: Array<{ phone: string; email?: string; nombre?: string; matched_lead_id: string | null }>
}

type SendResult = { ok: boolean; sent: number; skipped: number; total: number; campaign_id?: string; matched_leads?: number } | { error: string }

const STATUS_OPTIONS = [
  { value: 'nuevo', label: 'Nuevo' },
  { value: 'contactado', label: 'Contactado' },
  { value: 'llamada_agendada', label: 'Llamada agendada' },
  { value: 'no_show_llamada', label: 'No-show llamada' },
  { value: 'presentacion_enviada', label: 'Presentación enviada' },
  { value: 'espera_aprobacion', label: 'Espera aprobación' },
  { value: 'convertido', label: 'Convertido' },
  { value: 'cliente_recurrente', label: 'Cliente recurrente' },
  { value: 'descartado', label: 'Descartado' },
]

const PRESUPUESTO_OPTIONS = [
  { value: 'none', label: 'No invierte' },
  { value: '100_to_1000', label: '$100 — $1,000' },
  { value: '2000_to_5000', label: '$2,000 — $5,000' },
  { value: '10000_plus', label: '$10,000+' },
]

const CANAL_OPTIONS = ['Vambe', 'Instagram', 'TikTok', 'Facebook', 'Google', 'WhatsApp', 'Calendar booking', 'Recomendación', 'Inbound', 'LinkedIn']

function extractBody(t: Template): string {
  if (typeof t.body === 'string' && t.body.trim()) return t.body
  const components = t.components as Array<{ type?: string; text?: string }> | undefined
  if (Array.isArray(components)) {
    const body = components.find(c => (c.type || '').toUpperCase() === 'BODY')
    if (body?.text) return body.text
  }
  return ''
}

/**
 * Extrae las variables del cuerpo de un template ({{1}}, {{nombre}}, {{...}}).
 * Devuelve nombres únicos en el orden de aparición.
 */
function extractVariables(body: string): string[] {
  if (!body) return []
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g
  const found = new Set<string>()
  const ordered: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const key = m[1].trim()
    if (!found.has(key)) {
      found.add(key)
      ordered.push(key)
    }
  }
  return ordered
}

/**
 * Parsea un CSV simple (sin quotes complejas) a array de objetos usando la
 * primera fila como headers. Suficiente para listas de leads desde Excel.
 */
function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const parseLine = (line: string): string[] => {
    // Soporta comillas dobles para escapar comas
    const out: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
        else inQuote = !inQuote
      } else if (c === ',' && !inQuote) {
        out.push(cur); cur = ''
      } else {
        cur += c
      }
    }
    out.push(cur)
    return out.map(s => s.trim())
  }
  const headers = parseLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'))
  const rows: Array<Record<string, string>> = []
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i])
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => { obj[h] = cells[idx] || '' })
    rows.push(obj)
  }
  return rows
}

function statusBadge(s: string | undefined): { label: string; bg: string; color: string } {
  const norm = (s || '').toUpperCase()
  if (['PENDING', 'IN_REVIEW', 'PENDIENTE', 'SUBMITTED'].includes(norm)) {
    return { label: 'Pendiente', bg: 'rgba(255, 184, 0, 0.15)', color: '#ffb800' }
  }
  if (['REJECTED', 'DISABLED', 'RECHAZADO', 'PAUSED'].includes(norm)) {
    return { label: 'Rechazado', bg: 'rgba(255, 90, 90, 0.15)', color: '#ff5a5a' }
  }
  return { label: 'Aprobado', bg: 'rgba(0, 200, 160, 0.15)', color: '#00c8a0' }
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`
}

export default function TemplatesClient() {
  const [tab, setTab] = useState<'templates' | 'historial'>('templates')
  const [templates, setTemplates] = useState<Template[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState({ q: '', category: 'ALL' })
  const [sending, setSending] = useState<Template | null>(null)
  const [campaignDetail, setCampaignDetail] = useState<Campaign | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetch('/api/templates').then(r => r.json()).catch(() => ({ templates: [] })),
      fetch('/api/campaigns').then(r => r.json()).catch(() => ({ campaigns: [] })),
    ])
      .then(([t, c]) => {
        if (cancelled) return
        if (t.error) setError(t.error)
        setTemplates(t.templates || [])
        setCampaigns(c.campaigns || [])
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const t of templates) if (t.category) set.add(t.category)
    return Array.from(set).sort()
  }, [templates])

  const visible = useMemo(() => {
    const q = filter.q.trim().toLowerCase()
    return templates.filter(t => {
      if (filter.category !== 'ALL' && (t.category || '') !== filter.category) return false
      if (q) {
        const hay = `${t.name || ''} ${extractBody(t)}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [templates, filter])

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="templates" />
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <div>
            <h1>✉️ Templates</h1>
            <span className={styles.topSubtitle}>
              Dispará templates a leads, segmentos o listas de Excel — y mediles el outcome.
            </span>
          </div>
          <a
            href="https://app.vambeai.com/templates"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.createBtn}
          >
            + Crear template en Vambe ↗
          </a>
        </header>

        <div className={styles.tabs}>
          <button
            className={tab === 'templates' ? styles.tabActive : styles.tab}
            onClick={() => setTab('templates')}
          >
            Templates ({templates.length})
          </button>
          <button
            className={tab === 'historial' ? styles.tabActive : styles.tab}
            onClick={() => setTab('historial')}
          >
            Historial ({campaigns.length})
          </button>
        </div>

        {tab === 'templates' && (
          <>
            <div className={styles.infoBanner}>
              Los templates se crean en Vambe (Meta requiere aprobación). Acá los disparás a leads del CRM,
              segmentos filtrados o listas CSV con sus propios datos.
            </div>

            <div className={styles.filters}>
              <input
                type="text"
                placeholder="Buscar por nombre o contenido…"
                value={filter.q}
                onChange={e => setFilter(f => ({ ...f, q: e.target.value }))}
                className={styles.search}
              />
              <select
                value={filter.category}
                onChange={e => setFilter(f => ({ ...f, category: e.target.value }))}
                className={styles.select}
              >
                <option value="ALL">Todas las categorías</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div className={styles.count}>
                {loading ? 'Cargando…' : `${visible.length} de ${templates.length} templates`}
              </div>
            </div>

            <div className={styles.body}>
              {error && <div className={styles.error}>⚠️ {error}</div>}
              {!loading && !error && visible.length === 0 && (
                <div className={styles.empty}>
                  {templates.length === 0
                    ? 'No hay templates en Vambe todavía. Creá uno desde el dashboard de Vambe.'
                    : 'Ningún template coincide con el filtro.'}
                </div>
              )}

              <div className={styles.grid}>
                {visible.map(t => {
                  const badge = statusBadge(t.status)
                  const body = extractBody(t)
                  const vars = extractVariables(body)
                  return (
                    <div key={t.id} className={styles.card}>
                      <div className={styles.cardHead}>
                        <h3 className={styles.cardName}>{t.name || '(sin nombre)'}</h3>
                        <span className={styles.badge} style={{ background: badge.bg, color: badge.color }}>
                          {badge.label}
                        </span>
                      </div>
                      <div className={styles.cardMeta}>
                        {t.category && <span>{t.category}</span>}
                        {t.language && <span>· {t.language}</span>}
                        {vars.length > 0 && <span>· {vars.length} variable{vars.length === 1 ? '' : 's'}</span>}
                      </div>
                      {body && (
                        <div className={styles.cardBody}>
                          {body.length > 220 ? `${body.slice(0, 220)}…` : body}
                        </div>
                      )}
                      <div className={styles.cardFoot}>
                        <code className={styles.cardId}>{t.id.slice(0, 8)}…</code>
                        <button
                          className={styles.sendBtn}
                          onClick={() => setSending(t)}
                          title="Enviar a leads"
                        >
                          Enviar →
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}

        {tab === 'historial' && (
          <div className={styles.body}>
            {campaigns.length === 0 && (
              <div className={styles.empty}>
                Todavía no hay envíos. Cuando dispares una campaña desde la pestaña Templates, va a aparecer acá.
              </div>
            )}
            <div className={styles.campaignsGrid}>
              {campaigns.map(c => (
                <CampaignCard key={c.id} campaign={c} onOpen={() => setCampaignDetail(c)} />
              ))}
            </div>
          </div>
        )}
      </main>

      {sending && (
        <SendModal template={sending} onClose={() => setSending(null)} />
      )}
      {campaignDetail && (
        <CampaignDetailModal campaign={campaignDetail} onClose={() => setCampaignDetail(null)} />
      )}
    </div>
  )
}

// ─── Campaign card (historial) ─────────────────────────────────────────
function CampaignCard({ campaign: c, onOpen }: { campaign: Campaign; onOpen: () => void }) {
  return (
    <div className={styles.campaignCard} onClick={onOpen}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardName}>{c.template_name || c.template_id.slice(0, 12) + '…'}</h3>
        <span className={styles.sourceBadge}>{c.source}</span>
      </div>
      <div className={styles.cardMeta}>{fmtDate(c.created_at)} · {c.metrics.sent} enviados</div>
      <div className={styles.metricsRow}>
        <div className={styles.metric}>
          <div className={styles.metricVal}>{c.metrics.sent}</div>
          <div className={styles.metricLabel}>Enviados</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricVal}>{c.metrics.responded}</div>
          <div className={styles.metricLabel}>Respondió · {fmtPct(c.metrics.responded_rate)}</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricVal}>{c.metrics.scheduled}</div>
          <div className={styles.metricLabel}>Agendó · {fmtPct(c.metrics.scheduled_rate)}</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricVal}>{c.metrics.paid}</div>
          <div className={styles.metricLabel}>Pagó · {fmtPct(c.metrics.paid_rate)}</div>
        </div>
      </div>
    </div>
  )
}

// ─── Campaign detail modal ─────────────────────────────────────────────
function CampaignDetailModal({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const [detail, setDetail] = useState<{ campaign: Campaign; recipients: Array<{ id: string; phone: string; email: string | null; nombre: string | null; sent_at: string | null; responded_at: string | null; scheduled_call_at: string | null; paid_at: string | null; send_error: string | null; leads: { id: string; status: string; nombre: string | null } | null }> } | null>(null)

  useEffect(() => {
    fetch(`/api/campaigns/${campaign.id}`).then(r => r.json()).then(setDetail).catch(() => null)
  }, [campaign.id])

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: 900 }}>
        <div className={styles.modalHead}>
          <h2 className={styles.modalTitle}>{campaign.template_name || campaign.template_id}</h2>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <div className={styles.modalSub}>{fmtDate(campaign.created_at)} · {campaign.source}</div>

        <div className={styles.metricsRow} style={{ marginTop: 16, marginBottom: 16 }}>
          <div className={styles.metric}>
            <div className={styles.metricVal}>{campaign.metrics.sent}</div>
            <div className={styles.metricLabel}>Enviados</div>
          </div>
          <div className={styles.metric}>
            <div className={styles.metricVal}>{campaign.metrics.responded}</div>
            <div className={styles.metricLabel}>Respondió</div>
          </div>
          <div className={styles.metric}>
            <div className={styles.metricVal}>{campaign.metrics.scheduled}</div>
            <div className={styles.metricLabel}>Agendó</div>
          </div>
          <div className={styles.metric}>
            <div className={styles.metricVal}>{campaign.metrics.paid}</div>
            <div className={styles.metricLabel}>Pagó</div>
          </div>
        </div>

        {!detail && <div className={styles.help}>Cargando recipients…</div>}
        {detail && (
          <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 12 }}>
            <table className={styles.recipientsTable} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--glass-strong)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px' }}>Nombre</th>
                  <th style={{ padding: '8px 12px' }}>Teléfono</th>
                  <th style={{ padding: '8px 12px' }}>Status CRM</th>
                  <th style={{ padding: '8px 12px' }}>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {detail.recipients.map(r => {
                  const outcome = r.paid_at ? '💰 Pagó' : r.scheduled_call_at ? '📅 Agendó' : r.responded_at ? '💬 Respondió' : r.send_error ? '⚠️ Falló' : r.sent_at ? '✓ Enviado' : 'pendiente'
                  return (
                    <tr key={r.id} className={styles.recipientRow} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px' }}>{r.nombre || r.leads?.nombre || '—'}</td>
                      <td data-label="Teléfono" style={{ padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11 }}>{r.phone}</td>
                      <td data-label="Status CRM" style={{ padding: '8px 12px' }}>{r.leads?.status || '—'}</td>
                      <td data-label="Outcome" style={{ padding: '8px 12px' }}>{outcome}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Send Modal (tabs: Segmento / Excel / IDs + variables) ─────────────
function SendModal({ template, onClose }: { template: Template; onClose: () => void }) {
  const body = extractBody(template)
  const variables = useMemo(() => extractVariables(body), [body])
  const [mode, setMode] = useState<'segment' | 'excel'>('segment')
  const [segment, setSegment] = useState<SegmentFilter>({ status: ['nuevo'] })
  const [varValues, setVarValues] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<SendResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [csvRows, setCsvRows] = useState<Array<Record<string, string>>>([])
  const [csvError, setCsvError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto-preview
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setPreviewing(true)
      setErr(null)
      try {
        const reqBody: Record<string, unknown> = {
          templateId: template.id,
          templateName: template.name,
          templateBody: body,
          dryRun: true,
        }
        if (mode === 'segment') reqBody.segment = segment
        if (mode === 'excel') {
          if (csvRows.length === 0) { setPreview(null); setPreviewing(false); return }
          reqBody.externalRecipients = csvRows.map(r => {
            const out: Record<string, unknown> = {}
            // Detectar phone column
            const phone = r.phone || r.telefono || r.whatsapp || r.celular || r.phone_number
            out.phone_number = phone
            if (r.email) out.email = r.email
            if (r.nombre || r.name) out.nombre = r.nombre || r.name
            if (r.empresa) out.empresa = r.empresa
            if (r.vacante) out.vacante = r.vacante
            // Otros campos van como vars
            for (const [k, v] of Object.entries(r)) {
              if (!['phone', 'telefono', 'whatsapp', 'celular', 'phone_number', 'email', 'nombre', 'name', 'empresa', 'vacante'].includes(k)) {
                out[k] = v
              }
            }
            return out
          })
        }
        if (Object.keys(varValues).length) {
          const ov: Record<string, string> = {}
          for (const [k, v] of Object.entries(varValues)) {
            if (v.trim()) ov[k] = v
          }
          if (Object.keys(ov).length) reqBody.overrideVars = ov
        }
        const r = await fetch('/api/templates/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
        })
        const data = await r.json()
        if (cancelled) return
        if (data.error) setErr(data.error)
        else setPreview(data)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'error')
      } finally {
        if (!cancelled) setPreviewing(false)
      }
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [segment, template.id, template.name, body, varValues, mode, csvRows])

  const send = async () => {
    setSending(true)
    setErr(null)
    try {
      const reqBody: Record<string, unknown> = {
        templateId: template.id,
        templateName: template.name,
        templateBody: body,
      }
      if (mode === 'segment') reqBody.segment = segment
      if (mode === 'excel') {
        reqBody.externalRecipients = csvRows.map(r => {
          const out: Record<string, unknown> = {}
          const phone = r.phone || r.telefono || r.whatsapp || r.celular || r.phone_number
          out.phone_number = phone
          if (r.email) out.email = r.email
          if (r.nombre || r.name) out.nombre = r.nombre || r.name
          if (r.empresa) out.empresa = r.empresa
          if (r.vacante) out.vacante = r.vacante
          for (const [k, v] of Object.entries(r)) {
            if (!['phone', 'telefono', 'whatsapp', 'celular', 'phone_number', 'email', 'nombre', 'name', 'empresa', 'vacante'].includes(k)) {
              out[k] = v
            }
          }
          return out
        })
      }
      const ov: Record<string, string> = {}
      for (const [k, v] of Object.entries(varValues)) {
        if (v.trim()) ov[k] = v
      }
      if (Object.keys(ov).length) reqBody.overrideVars = ov

      const r = await fetch('/api/templates/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      })
      const data = await r.json()
      if (data.error) setErr(data.error)
      else setResult(data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'error')
    } finally {
      setSending(false)
    }
  }

  const onCsvFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setCsvError(null)
    try {
      const text = await f.text()
      const rows = parseCsv(text)
      if (rows.length === 0) {
        setCsvError('Archivo vacío o no se detectaron filas')
        return
      }
      // Validar que tenga al menos columna de teléfono
      const firstRow = rows[0]
      const hasPhone = ['phone', 'telefono', 'whatsapp', 'celular', 'phone_number'].some(k => firstRow[k])
      if (!hasPhone) {
        setCsvError(`No se detectó columna de teléfono. Columnas: ${Object.keys(firstRow).join(', ')}`)
        return
      }
      setCsvRows(rows)
    } catch (err) {
      setCsvError(err instanceof Error ? err.message : 'error parseando CSV')
    }
  }

  const toggleArrayValue = (arr: string[] | undefined, value: string): string[] => {
    const a = arr || []
    return a.includes(value) ? a.filter(v => v !== value) : [...a, value]
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h2 className={styles.modalTitle}>Enviar template</h2>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <div className={styles.modalSub}>{template.name}</div>

        {result && 'ok' in result && result.ok ? (
          <div className={styles.successBox}>
            ✓ Template enviado a <strong>{result.sent}</strong> lead{result.sent === 1 ? '' : 's'}
            {result.matched_leads != null && result.matched_leads !== result.sent && (
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 8 }}>
                {result.matched_leads} matcheados con leads del CRM · {result.sent - result.matched_leads} externos
              </div>
            )}
            <button className={styles.primaryBtn} style={{ marginTop: 16 }} onClick={onClose}>Cerrar</button>
          </div>
        ) : (
          <>
            {/* Tabs Segmento / Excel */}
            <div className={styles.subTabs}>
              <button
                className={mode === 'segment' ? styles.subTabActive : styles.subTab}
                onClick={() => setMode('segment')}
              >
                Por segmento
              </button>
              <button
                className={mode === 'excel' ? styles.subTabActive : styles.subTab}
                onClick={() => setMode('excel')}
              >
                Subir CSV/Excel
              </button>
            </div>

            {/* Variables del template */}
            {variables.length > 0 && (
              <div className={styles.section}>
                <label className={styles.label}>Variables del template ({variables.length})</label>
                <div className={styles.help} style={{ marginBottom: 8 }}>
                  Si dejás algunas en blanco, se autocompletan desde el lead (nombre, empresa, vacante).
                </div>
                <div className={styles.varGrid}>
                  {variables.map(v => (
                    <label key={v} className={styles.varInput}>
                      <span className={styles.varLabel}>{`{{${v}}}`}</span>
                      <input
                        type="text"
                        value={varValues[v] || ''}
                        onChange={e => setVarValues(vv => ({ ...vv, [v]: e.target.value }))}
                        placeholder={
                          v === '1' || v.toLowerCase().includes('nombre') ? 'auto: lead.nombre' :
                          v === '2' || v.toLowerCase().includes('empresa') ? 'auto: lead.empresa' :
                          v === '3' || v.toLowerCase().includes('vacante') ? 'auto: lead.vacante' :
                          'valor para todos'
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            {mode === 'segment' && (
              <>
                <div className={styles.section}>
                  <label className={styles.label}>Status del lead</label>
                  <div className={styles.chips}>
                    {STATUS_OPTIONS.map(o => (
                      <label key={o.value} className={styles.chip}>
                        <input
                          type="checkbox"
                          checked={segment.status?.includes(o.value) || false}
                          onChange={() => setSegment(s => ({ ...s, status: toggleArrayValue(s.status, o.value) }))}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className={styles.section}>
                  <label className={styles.label}>Canal de adquisición</label>
                  <div className={styles.chips}>
                    {CANAL_OPTIONS.map(c => (
                      <label key={c} className={styles.chip}>
                        <input
                          type="checkbox"
                          checked={segment.canal_adquisicion?.includes(c) || false}
                          onChange={() => setSegment(s => ({ ...s, canal_adquisicion: toggleArrayValue(s.canal_adquisicion, c) }))}
                        />
                        {c}
                      </label>
                    ))}
                  </div>
                </div>

                <div className={styles.sectionRow}>
                  <div style={{ flex: 1 }}>
                    <label className={styles.label}>Vacante contiene</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={segment.vacante || ''}
                      onChange={e => setSegment(s => ({ ...s, vacante: e.target.value || undefined }))}
                      placeholder="ej. seguridad"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className={styles.label}>Presupuesto</label>
                    <div className={styles.chips}>
                      {PRESUPUESTO_OPTIONS.map(o => (
                        <label key={o.value} className={styles.chip}>
                          <input
                            type="checkbox"
                            checked={segment.presupuesto?.includes(o.value) || false}
                            onChange={() => setSegment(s => ({ ...s, presupuesto: toggleArrayValue(s.presupuesto, o.value) }))}
                          />
                          {o.label}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={styles.sectionRow}>
                  <div style={{ flex: 1 }}>
                    <label className={styles.label}>Días sin contactar (min)</label>
                    <input
                      type="number"
                      min={0}
                      className={styles.input}
                      value={segment.diasSinContactarMin ?? ''}
                      onChange={e => setSegment(s => ({ ...s, diasSinContactarMin: e.target.value === '' ? undefined : Number(e.target.value) }))}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className={styles.label}>Días sin contactar (max)</label>
                    <input
                      type="number"
                      min={0}
                      className={styles.input}
                      value={segment.diasSinContactarMax ?? ''}
                      onChange={e => setSegment(s => ({ ...s, diasSinContactarMax: e.target.value === '' ? undefined : Number(e.target.value) }))}
                    />
                  </div>
                </div>
              </>
            )}

            {mode === 'excel' && (
              <div className={styles.section}>
                <label className={styles.label}>Subir CSV (exportable desde Excel)</label>
                <div className={styles.help} style={{ marginBottom: 8 }}>
                  Mínimo necesita una columna <code>phone</code>, <code>telefono</code> o <code>whatsapp</code>.
                  Opcionalmente: <code>email</code>, <code>nombre</code>, <code>empresa</code>, <code>vacante</code>, o cualquier otro campo
                  (los demás se pasan como variables al template).
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={onCsvFile}
                  className={styles.input}
                />
                {csvError && <div className={styles.error}>⚠️ {csvError}</div>}
                {csvRows.length > 0 && (
                  <div className={styles.help}>
                    ✓ Cargados <strong>{csvRows.length}</strong> destinatarios.
                    Columnas: {Object.keys(csvRows[0]).join(', ')}
                  </div>
                )}
              </div>
            )}

            <div className={styles.previewBox}>
              {previewing && <span className={styles.help}>Calculando…</span>}
              {!previewing && preview && (
                <>
                  <strong style={{ fontSize: 18, color: '#fff' }}>{preview.sendable}</strong>
                  <span className={styles.help}>
                    {' '}destinatario{preview.sendable === 1 ? '' : 's'} recibirá{preview.sendable === 1 ? '' : 'n'} el template
                    {preview.matched_leads != null && (
                      <> ({preview.matched_leads} matcheados con CRM)</>
                    )}
                    {preview.skipped > 0 && ` · ${preview.skipped} saltados`}
                  </span>
                </>
              )}
            </div>

            {err && <div className={styles.error}>⚠️ {err}</div>}

            <div className={styles.actions}>
              <button className={styles.secondaryBtn} onClick={onClose} disabled={sending}>Cancelar</button>
              <button
                className={styles.primaryBtn}
                onClick={send}
                disabled={sending || !preview || preview.sendable === 0}
              >
                {sending ? 'Enviando…' : `Enviar a ${preview?.sendable || 0}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
