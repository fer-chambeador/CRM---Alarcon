'use client'

import { useState, useRef, useEffect } from 'react'
import { Sidebar } from './CommandCenter'
import styles from './AsistenteClient.module.css'

type Turn = { question: string; answer: string | null; error?: string; loading?: boolean; usage?: { input_tokens: number; output_tokens: number } | null }

const SUGGESTIONS = [
  '¿Cuántos leads cayeron este mes y de qué canales?',
  'De los convertidos, ¿de qué estados son y quién era el decision maker?',
  '¿Qué canal tiene la mejor tasa de conversión?',
  '¿Qué leads tienen más de 48h sin moverse de "contactado"?',
  '¿Cuál es el pipeline cerrado de Instagram este mes?',
  '¿Qué estados tienen más leads sin contactar?',
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

export default function AsistenteClient() {
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  const ask = async (q: string) => {
    if (!q.trim() || busy) return
    setBusy(true)
    setQuestion('')
    const idx = turns.length
    setTurns(prev => [...prev, { question: q, answer: null, loading: true }])
    try {
      const res = await fetch('/api/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      const data = await res.json()
      setTurns(prev => prev.map((t, i) => i === idx
        ? { ...t, loading: false, answer: data.answer || null, error: data.error, usage: data.usage }
        : t))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error inesperado'
      setTurns(prev => prev.map((t, i) => i === idx ? { ...t, loading: false, error: msg } : t))
    } finally {
      setBusy(false)
    }
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
            placeholder="Preguntá sobre tus leads..."
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            disabled={busy}
          />
          <button className={styles.sendBtn} onClick={() => ask(question)} disabled={busy || !question.trim()}>
            {busy ? '…' : 'Enviar'}
          </button>
        </div>
      </main>
    </div>
  )
}
