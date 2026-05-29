'use client'

import { useEffect, useMemo, useState } from 'react'
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

type Preview = {
  total: number
  sendable: number
  skipped: number
  leads: Array<{ id: string; email: string; nombre: string | null; telefono: string | null }>
}

type SendResult = {
  ok: boolean
  sent: number
  skipped: number
  total: number
} | { error: string }

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

const CANAL_OPTIONS = ['Vambe', 'Instagram', 'TikTok', 'WhatsApp', 'Calendar booking', 'Otro']

function extractBody(t: Template): string {
  if (typeof t.body === 'string' && t.body.trim()) return t.body
  // Intentar extraer del components si existe (estructura típica de WhatsApp templates)
  const components = t.components as Array<{ type?: string; text?: string }> | undefined
  if (Array.isArray(components)) {
    const body = components.find(c => (c.type || '').toUpperCase() === 'BODY')
    if (body?.text) return body.text
  }
  return ''
}

function statusBadge(s: string | undefined): { label: string; bg: string; color: string } {
  const norm = (s || '').toUpperCase()
  if (norm === 'APPROVED') return { label: 'Aprobado', bg: 'rgba(0, 200, 160, 0.15)', color: '#00c8a0' }
  if (norm === 'PENDING') return { label: 'Pendiente', bg: 'rgba(255, 184, 0, 0.15)', color: '#ffb800' }
  if (norm === 'REJECTED') return { label: 'Rechazado', bg: 'rgba(255, 90, 90, 0.15)', color: '#ff5a5a' }
  return { label: norm || 'Desconocido', bg: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.65)' }
}

export default function TemplatesClient() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState({ q: '', status: 'ALL', category: 'ALL' })
  const [sending, setSending] = useState<Template | null>(null)

  // Cargar templates al montar
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/api/templates')
      .then(r => r.json())
      .then((data: { templates?: Template[]; error?: string }) => {
        if (cancelled) return
        if (data.error) { setError(data.error); return }
        setTemplates(data.templates || [])
      })
      .catch(e => { if (!cancelled) setError(e.message) })
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
      if (filter.status !== 'ALL' && (t.status || '').toUpperCase() !== filter.status) return false
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
              Dispará templates de WhatsApp a tus leads — recordatorios, updates, campañas.
            </span>
          </div>
          <a
            href="https://app.vambe.me/templates"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.createBtn}
          >
            + Crear template en Vambe ↗
          </a>
        </header>

        <div className={styles.infoBanner}>
          Los templates de WhatsApp requieren aprobación de Meta y se crean en el dashboard de Vambe.
          Acá los listás, los filtrás y los disparás a leads o segmentos.
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
            value={filter.status}
            onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}
            className={styles.select}
          >
            <option value="ALL">Todos los estados</option>
            <option value="APPROVED">Aprobado</option>
            <option value="PENDING">Pendiente</option>
            <option value="REJECTED">Rechazado</option>
          </select>
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
              const isApproved = (t.status || '').toUpperCase() === 'APPROVED'
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
                    {t.channel_type && <span>· {t.channel_type}</span>}
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
                      disabled={!isApproved}
                      title={isApproved ? 'Enviar a leads' : 'Solo los templates aprobados se pueden enviar'}
                    >
                      Enviar →
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </main>

      {sending && (
        <SendModal template={sending} onClose={() => setSending(null)} />
      )}
    </div>
  )
}

// ─── Send Modal ─────────────────────────────────────────────────────────
function SendModal({ template, onClose }: { template: Template; onClose: () => void }) {
  const [segment, setSegment] = useState<SegmentFilter>({ status: ['nuevo'] })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<SendResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [overrideText, setOverrideText] = useState('')

  // Auto-preview al cambiar segmento
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      setPreviewing(true)
      setErr(null)
      try {
        const r = await fetch('/api/templates/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateId: template.id, segment, dryRun: true }),
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
  }, [segment, template.id])

  const send = async () => {
    setSending(true)
    setErr(null)
    try {
      const overrideVars: Record<string, string> = {}
      if (overrideText.trim()) {
        // Parsear "key=value, key2=value2"
        for (const part of overrideText.split(',')) {
          const [k, ...rest] = part.split('=')
          const key = k?.trim()
          const value = rest.join('=').trim()
          if (key && value) overrideVars[key] = value
        }
      }
      const r = await fetch('/api/templates/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: template.id,
          segment,
          overrideVars: Object.keys(overrideVars).length ? overrideVars : undefined,
        }),
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

  const toggleArrayValue = (arr: string[] | undefined, value: string): string[] => {
    const a = arr || []
    return a.includes(value) ? a.filter(v => v !== value) : [...a, value]
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <h2 className={styles.modalTitle}>Enviar template</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Cerrar">×</button>
        </div>
        <div className={styles.modalSub}>{template.name}</div>

        {result && 'ok' in result && result.ok ? (
          <div className={styles.successBox}>
            ✓ Template enviado a <strong>{result.sent}</strong> lead{result.sent === 1 ? '' : 's'}
            {result.skipped > 0 && <span style={{ opacity: 0.7 }}> · {result.skipped} sin teléfono saltados</span>}
            <button className={styles.primaryBtn} style={{ marginTop: 16 }} onClick={onClose}>Cerrar</button>
          </div>
        ) : (
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
                  placeholder="ej. guardia"
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

            <div className={styles.section}>
              <label className={styles.label}>Variables override (opcional)</label>
              <input
                type="text"
                className={styles.input}
                value={overrideText}
                onChange={e => setOverrideText(e.target.value)}
                placeholder='key=valor, otra_key=otro_valor'
              />
              <div className={styles.help}>
                Por defecto mandamos <code>nombre</code>, <code>empresa</code>, <code>vacante</code>, <code>email</code> y <code>puesto</code>
                {' '}auto-completados desde cada lead. Acá podés agregar/sobrescribir variables para todos.
              </div>
            </div>

            <div className={styles.previewBox}>
              {previewing && <span className={styles.help}>Calculando…</span>}
              {!previewing && preview && (
                <>
                  <strong style={{ fontSize: 18, color: '#fff' }}>{preview.sendable}</strong>
                  <span className={styles.help}>
                    {' '}lead{preview.sendable === 1 ? '' : 's'} con teléfono recibirá{preview.sendable === 1 ? '' : 'n'} el template
                    {preview.skipped > 0 && ` (${preview.skipped} sin teléfono saltados)`}
                  </span>
                </>
              )}
              {!previewing && !preview && err && <span className={styles.error}>⚠️ {err}</span>}
            </div>

            {err && !previewing && <div className={styles.error}>⚠️ {err}</div>}

            <div className={styles.actions}>
              <button className={styles.secondaryBtn} onClick={onClose} disabled={sending}>Cancelar</button>
              <button
                className={styles.primaryBtn}
                onClick={send}
                disabled={sending || !preview || preview.sendable === 0}
              >
                {sending ? 'Enviando…' : `Enviar a ${preview?.sendable || 0} lead${preview?.sendable === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
