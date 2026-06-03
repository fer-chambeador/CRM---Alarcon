'use client'

import { useState, useRef, useEffect } from 'react'
import { Sidebar } from './CommandCenter'
import styles from './AsistenteClient.module.css'

type Action = {
  tool: string
  input: unknown
  result: {
    ok: boolean
    summary: string
    affected?: Array<{ id: string; email: string; nombre?: string | null }>
    data?: unknown
    error?: string
  }
}
type Turn = {
  question: string
  answer: string | null
  error?: string
  loading?: boolean
  usage?: { input_tokens: number; output_tokens: number } | null
  actions?: Action[]
}

const SUGGESTIONS = [
  // Reportes (NUEVO)
  'Dame un reporte ejecutivo del mes con patrones detectados',
  'Análisis del flow Dapta: qué % pasa de llamada exitosa a propuesta a pago',
  'Reporte de canales: cuál convierte más por monto invertido',
  // Outbound masivo
  'Mándame outbound a todos los nuevos de Facebook que llevan ≥3 días sin contactar',
  'Manda follow-up a los contactado que llevan 5 días sin moverse',
  // Bulk updates
  'Descarta a los leads en contactado con más de 30 días sin avance',
  'Marca como espera de aprobación a los presentacion_enviada que llevan más de 48h',
  // Listas filtradas
  '¿Qué leads hot debo contactar hoy?',
  'Lista los 10 leads con interés alto que aún no convierten',
  // Análisis Dapta
  '¿Cuántas llamadas de Daniela fueron exitosas esta semana? ¿qué outcomes detectó?',
]

// Tiny markdown renderer — handles **bold**, `code`, *italic*, lists, line breaks. No external dep.
function renderMarkdown(s: string): string {
  let out = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  // Bullet lists: lines starting with "- " or "* "
  out = out.replace(/(^|\n)([-*] .+(?:\n[-*] .+)*)/g, (_, p, block) => {
    const items = block.split('\n').map((l: string) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('')
    return `${p}<ul>${items}</ul>`
  })
  // Numbered lists: lines starting with "1. ..."
  out = out.replace(/(^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_, p, block) => {
    const items = block.trim().split('\n').map((l: string) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('')
    return `${p}<ol>${items}</ol>`
  })
  // Markdown tables (simple)
  out = out.replace(/((?:^|\n)\|.+\|(?:\n\|[\s\-:|]+\|)?(?:\n\|.+\|)+)/g, (block) => {
    const lines = block.trim().split('\n').filter(l => l.trim().startsWith('|'))
    if (lines.length < 2) return block
    const hasSeparator = /^\|[\s\-:|]+\|$/.test(lines[1].trim())
    const headers = lines[0].split('|').slice(1, -1).map(c => c.trim())
    const dataLines = hasSeparator ? lines.slice(2) : lines.slice(1)
    const rows = dataLines.map(l => l.split('|').slice(1, -1).map(c => c.trim()))
    const thead = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`
    const tbody = `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`
    return `\n<table class="${styles.mdTable}">${thead}${tbody}</table>`
  })
  // Paragraph wrap remaining content
  out = out.split(/\n{2,}/).map(block => {
    const t = block.trim()
    if (!t) return ''
    if (t.startsWith('<')) return t
    return `<p>${t.replace(/\n/g, '<br>')}</p>`
  }).join('')
  return out
}

type ConfirmKey = string  // `${turnIdx}-${actionIdx}`
type ConfirmState = { loading?: boolean; result?: Action['result']; error?: string }
type AttachedFile = { name: string; content: string; size: number }

const STORAGE_KEY = 'chambas-asistente-turns'

export default function AsistenteClient() {
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState<Record<ConfirmKey, ConfirmState>>({})
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Cargar turnos persistidos al montar
  useEffect(() => {
    inputRef.current?.focus()
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) setTurns(parsed)
      }
    } catch { /* ignore */ }
  }, [])

  // Persistir turnos en localStorage al cambiar
  useEffect(() => {
    if (turns.length === 0) return
    try {
      // Cap a últimos 20 turnos para no llenar localStorage
      const toSave = turns.slice(-20).map(t => ({ ...t, loading: false, actions: undefined }))
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
    } catch { /* ignore */ }
  }, [turns])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  const clearHistory = () => {
    if (!confirm('¿Limpiar todo el historial del asistente?')) return
    setTurns([])
    setConfirmed({})
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }

  const ask = async (q: string) => {
    if ((!q.trim() && !attachedFile) || busy) return
    setBusy(true)
    setQuestion('')
    const file = attachedFile
    setAttachedFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    const idx = turns.length
    // Construir el mensaje: si hay file, prefix el contenido
    let fullQuestion = q
    if (file) {
      fullQuestion = `[ARCHIVO ADJUNTO: ${file.name}, ${file.size} bytes]\n\`\`\`\n${file.content}\n\`\`\`\n\n${q || '(usá el archivo adjunto como contexto para responder)'}`
    }
    setTurns(prev => [...prev, { question: q + (file ? ` 📎 ${file.name}` : ''), answer: null, loading: true }])
    // Memoria: mandar los últimos 3 turnos completos (preguntas + respuestas) para
    // permitir follow-ups tipo "y de esos, cuántos respondieron?"
    const history = turns.slice(-3).flatMap(t => {
      const h: Array<{ role: 'user' | 'assistant'; content: string }> = []
      if (t.question) h.push({ role: 'user', content: t.question })
      if (t.answer) h.push({ role: 'assistant', content: t.answer })
      return h
    })
    try {
      const res = await fetch('/api/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: fullQuestion, history }),
      })
      const data = await res.json()
      setTurns(prev => prev.map((t, i) => i === idx
        ? { ...t, loading: false, answer: data.answer || null, error: data.error, usage: data.usage, actions: data.actions }
        : t))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error inesperado'
      setTurns(prev => prev.map((t, i) => i === idx ? { ...t, loading: false, error: msg } : t))
    } finally {
      setBusy(false)
    }
  }

  /** Confirmar acción riesgosa (bulk_update dry-run) → llamar a /api/ai/execute-tool con confirm=true. */
  const confirmAction = async (key: ConfirmKey, action: Action) => {
    setConfirmed(c => ({ ...c, [key]: { loading: true } }))
    try {
      // Para bulk_update_status, agregamos confirm: true al input
      const newInput = action.tool === 'bulk_update_status'
        ? { ...(action.input as Record<string, unknown>), confirm: true }
        : action.input
      const res = await fetch('/api/ai/execute-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: action.tool, input: newInput }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setConfirmed(c => ({ ...c, [key]: { result: data.result } }))
    } catch (e) {
      setConfirmed(c => ({ ...c, [key]: { error: e instanceof Error ? e.message : 'falló' } }))
    }
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    // Limit 1MB para no inflar contexto
    if (f.size > 1024 * 1024) {
      alert('Archivo muy grande. Límite: 1 MB')
      return
    }
    const content = await f.text()
    setAttachedFile({ name: f.name, content, size: f.size })
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      ask(question)
    }
  }

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="asistente" />
      </aside>

      <main className={styles.main}>
        <header className={styles.topBar}>
          <h1>🧠 Asistente</h1>
          <span className={styles.topSubtitle}>Preguntá lo que sea sobre tus leads — en lenguaje natural.</span>
          {turns.length > 0 && (
            <button
              onClick={clearHistory}
              style={{
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--text3)', fontSize: 11, padding: '4px 10px',
                borderRadius: 6, cursor: 'pointer', marginLeft: 'auto',
                fontFamily: 'var(--font)',
              }}
              title="Borra el historial del asistente"
            >
              🗑️ Limpiar historial
            </button>
          )}
        </header>

        <div className={styles.body} ref={scrollRef}>
          {turns.length === 0 && (
            <div className={styles.welcome}>
              <p>Probá con uno de estos:</p>
              <div className={styles.suggestions}>
                {SUGGESTIONS.map((s, i) => (
                  <button key={i} className={styles.suggestion} onClick={() => ask(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            <div key={i} className={styles.turn}>
              <div className={styles.userBubble}>
                <span className={styles.userLabel}>Vos</span>
                <div>{t.question}</div>
              </div>
              <div className={styles.assistantBubble}>
                <span className={styles.assistantLabel}>🧠 Asistente</span>
                {t.loading && <div className={styles.loading}>Pensando…</div>}
                {t.error && <div className={styles.error}>⚠️ {t.error}</div>}
                {t.answer && (
                  <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: renderMarkdown(t.answer) }} />
                )}
                {t.actions && t.actions.length > 0 && (
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {t.actions.map((a, j) => {
                      const confirmKey = `${i}-${j}`
                      const confirmState = confirmed[confirmKey]
                      // File download action
                      const fileData = (a.result.data && typeof a.result.data === 'object'
                        && (a.result.data as { file?: boolean }).file)
                        ? a.result.data as { file: true; filename: string; mime_type: string; content: string; size_bytes: number }
                        : null
                      // Detect dry-run de bulk_update que necesita confirmación
                      const dryRunData = a.result.data as { total_matched?: number } | undefined
                      const isDryRun = a.tool === 'bulk_update_status'
                        && a.result.ok
                        && (a.input as { confirm?: boolean })?.confirm !== true
                        && (dryRunData?.total_matched ?? 0) > 0
                        && !confirmState?.result
                      return (
                        <div key={j} style={{
                          background: 'var(--glass)',
                          border: '1px solid var(--border)',
                          borderLeft: `3px solid ${a.result.ok ? '#22d68a' : '#f05a5a'}`,
                          borderRadius: 10, padding: '10px 14px',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <span style={{ fontSize: 14 }}>{a.result.ok ? '✓' : '⚠️'}</span>
                            <strong style={{ fontSize: 12.5, color: 'var(--text)' }}>{a.tool}</strong>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text2)' }}>{a.result.summary}</div>
                          {fileData && (
                            <button
                              onClick={() => {
                                const blob = new Blob([fileData.content], { type: fileData.mime_type })
                                const url = URL.createObjectURL(blob)
                                const link = document.createElement('a')
                                link.href = url
                                link.download = fileData.filename
                                document.body.appendChild(link)
                                link.click()
                                document.body.removeChild(link)
                                setTimeout(() => URL.revokeObjectURL(url), 500)
                              }}
                              style={{
                                marginTop: 10,
                                background: 'linear-gradient(90deg, #22d68a, #00c8a0)',
                                color: '#0a0a12', border: 'none',
                                padding: '8px 16px', borderRadius: 8,
                                fontSize: 13, fontWeight: 700, cursor: 'pointer',
                                fontFamily: 'var(--font)',
                                display: 'inline-flex', alignItems: 'center', gap: 6,
                              }}>
                              ⇣ Descargar {fileData.filename}
                              <span style={{ fontSize: 10.5, opacity: 0.7 }}>
                                ({(fileData.size_bytes / 1024).toFixed(1)} KB)
                              </span>
                            </button>
                          )}
                          {a.result.affected && a.result.affected.length > 0 && (
                            <details style={{ marginTop: 6 }} open={isDryRun}>
                              <summary style={{ fontSize: 11, color: 'var(--text3)', cursor: 'pointer' }}>
                                Ver {a.result.affected.length} lead{a.result.affected.length === 1 ? '' : 's'} afectado{a.result.affected.length === 1 ? '' : 's'}
                              </summary>
                              <ul style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4, paddingLeft: 20 }}>
                                {a.result.affected.map((af, k) => (
                                  <li key={k}>{af.nombre || af.email}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                          {isDryRun && (
                            <div style={{
                              marginTop: 12, padding: '12px 14px',
                              background: 'rgba(245,200,66,0.08)',
                              border: '1px solid rgba(245,200,66,0.3)',
                              borderRadius: 8,
                            }}>
                              <div style={{ fontSize: 12.5, color: 'var(--text)', marginBottom: 8 }}>
                                ⚠️ Esto es un <strong>preview</strong>. Vas a aplicar el cambio a <strong>{dryRunData?.total_matched}</strong> lead{dryRunData?.total_matched === 1 ? '' : 's'}.
                              </div>
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button onClick={() => confirmAction(confirmKey, a)} disabled={confirmState?.loading}
                                  style={{
                                    background: '#f5c842', color: '#1a1a2e', border: 'none',
                                    padding: '7px 14px', borderRadius: 6, fontSize: 12.5,
                                    fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
                                  }}>
                                  {confirmState?.loading ? 'Aplicando…' : `✓ Confirmar y aplicar`}
                                </button>
                                <button onClick={() => setConfirmed(c => ({ ...c, [confirmKey]: { result: { ok: true, summary: 'Cancelado por el usuario' } } }))}
                                  style={{
                                    background: 'transparent', color: 'var(--text3)',
                                    border: '1px solid var(--border)',
                                    padding: '7px 14px', borderRadius: 6, fontSize: 12.5,
                                    cursor: 'pointer', fontFamily: 'var(--font)',
                                  }}>
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          )}
                          {confirmState?.result && (
                            <div style={{
                              marginTop: 10, padding: '10px 14px',
                              background: confirmState.result.ok ? 'rgba(34,214,138,0.08)' : 'rgba(240,90,90,0.08)',
                              border: `1px solid ${confirmState.result.ok ? 'rgba(34,214,138,0.3)' : 'rgba(240,90,90,0.3)'}`,
                              borderRadius: 8, fontSize: 12,
                              color: confirmState.result.ok ? '#22d68a' : '#f05a5a',
                            }}>
                              {confirmState.result.ok ? '✓' : '⚠️'} {confirmState.result.summary}
                            </div>
                          )}
                          {confirmState?.error && (
                            <div style={{ marginTop: 8, fontSize: 12, color: '#f05a5a' }}>⚠️ {confirmState.error}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
                {t.usage && (
                  <div className={styles.usage}>
                    {t.usage.input_tokens} input · {t.usage.output_tokens} output tokens
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className={styles.composer}>
          <textarea
            ref={inputRef}
            className={styles.input}
            placeholder={attachedFile ? `Hablale del archivo "${attachedFile.name}"...` : 'Preguntá sobre tus leads...'}
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            disabled={busy}
          />
          <input ref={fileInputRef} type="file" accept=".csv,.txt,.json,.tsv" onChange={onFile}
            style={{ display: 'none' }} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            title="Subir archivo (CSV, TXT, JSON) para que el asistente lo procese"
            style={{
              background: 'var(--glass)', border: '1px solid var(--border2)',
              color: 'var(--text2)', padding: '0 14px', borderRadius: 'var(--radius-pill)',
              fontSize: 18, cursor: 'pointer', fontFamily: 'var(--font)',
              minHeight: 44,
            }}>
            📎
          </button>
          <button className={styles.sendBtn} onClick={() => ask(question)} disabled={busy || (!question.trim() && !attachedFile)}>
            {busy ? '…' : 'Enviar'}
          </button>
        </div>
        {attachedFile && (
          <div style={{
            margin: '8px 32px 0', padding: '8px 12px',
            background: 'var(--glass)', border: '1px solid var(--border)',
            borderRadius: 8, fontSize: 12, color: 'var(--text2)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span>📎</span>
            <span><strong style={{ color: 'var(--text)' }}>{attachedFile.name}</strong> · {(attachedFile.size / 1024).toFixed(1)} KB adjunto</span>
            <button onClick={() => { setAttachedFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
              style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 14 }}>
              ✕
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
