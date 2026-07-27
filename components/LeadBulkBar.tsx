'use client'

/**
 * Barra flotante de envío masivo desde la tabla de Leads.
 * Aparece cuando hay ≥1 lead seleccionado con las casillas.
 * Deja elegir CANAL (Vambe con plantilla aprobada, o el WhatsApp de Fer/WA Bridge)
 * y dispara el envío a los seleccionados.
 */

import { useEffect, useState } from 'react'

type Tpl = { id: string; name: string; preview: string; category: string }
type LiteLead = { id: string; telefono: string | null; nombre: string | null; empresa: string | null }

// Stage destino para envíos por Vambe (igual que el default del wizard de Outbound):
// mueve el lead a "Interesado" para que el Asistente Agendador tome el chat.
const STAGE_INTERESADO = '96c42cda-2828-45db-973c-3bc63a8141fd'

export function LeadBulkBar({
  selectedIds,
  leads,
  onDone,
}: {
  selectedIds: Set<string>
  leads: LiteLead[]
  onDone: () => void
}) {
  const [templates, setTemplates] = useState<Tpl[]>([])
  const [channel, setChannel] = useState<'vambe' | 'wb'>('vambe')
  const [templateId, setTemplateId] = useState('')
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/outbound/templates')
      .then((r) => r.json())
      .then((d) => setTemplates(Array.isArray(d.templates) ? d.templates : []))
      .catch(() => {})
  }, [])

  if (selectedIds.size === 0) return null

  const chosen = leads.filter((l) => selectedIds.has(l.id) && l.telefono)
  const n = chosen.length
  const sinTel = selectedIds.size - n

  async function send() {
    if (channel === 'vambe' && !templateId) {
      alert('Elige una plantilla de Vambe primero.')
      return
    }
    if (n === 0) {
      alert('Ninguno de los leads seleccionados tiene teléfono.')
      return
    }
    const canalTxt = channel === 'vambe' ? 'Vambe' : 'tu WhatsApp'
    if (!confirm(`¿Enviar el mensaje a ${n} lead(s) por ${canalTxt}?`)) return

    setSending(true)
    setResult(null)
    let ok = 0
    let err = 0

    try {
      if (channel === 'vambe') {
        const payload = chosen.map((l) => ({ id: l.id, phone: l.telefono }))
        setProgress({ done: 0, total: payload.length })
        for (let i = 0; i < payload.length; i += 100) {
          const batch = payload.slice(i, i + 100)
          const res = await fetch('/api/outbound/dispatch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ templateId, stageId: STAGE_INTERESADO, leads: batch }),
          })
          const data = (await res.json().catch(() => ({}))) as { results?: { ok: boolean }[] }
          if (Array.isArray(data.results)) {
            for (const r of data.results) r.ok ? ok++ : err++
          } else {
            err += batch.length
          }
          setProgress({ done: Math.min(i + batch.length, payload.length), total: payload.length })
        }
      } else {
        setProgress({ done: 0, total: n })
        for (let i = 0; i < chosen.length; i++) {
          const l = chosen[i]
          try {
            const res = await fetch(`/api/leads/${l.id}/wa-direct`, { method: 'POST' })
            const data = (await res.json().catch(() => ({}))) as { ok?: boolean }
            data.ok ? ok++ : err++
          } catch {
            err++
          }
          setProgress({ done: i + 1, total: n })
          await new Promise((r) => setTimeout(r, 400))
        }
      }
      setResult(`Enviados: ${ok} · Fallidos: ${err}`)
      if (err === 0) {
        setTimeout(() => {
          setResult(null)
          setProgress(null)
          onDone()
        }, 2500)
      } else {
        setProgress(null)
      }
    } finally {
      setSending(false)
    }
  }

  const chanBtn = (active: boolean) => ({
    padding: '6px 12px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer' as const,
    fontSize: 13,
    fontWeight: 600,
    background: active ? '#7c6af7' : 'transparent',
    color: active ? '#fff' : '#9aa0b4',
  })

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 22,
        zIndex: 300,
        background: '#15151f',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 14,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        boxShadow: '0 10px 34px rgba(0,0,0,0.55)',
        flexWrap: 'wrap',
        maxWidth: '94vw',
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>
        {selectedIds.size} seleccionado{selectedIds.size === 1 ? '' : 's'}
        {sinTel > 0 && <span style={{ color: '#f0a15a', fontWeight: 400, fontSize: 12 }}> · {sinTel} sin tel</span>}
      </span>

      <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 8, padding: 3 }}>
        <button onClick={() => setChannel('vambe')} style={chanBtn(channel === 'vambe')}>Vambe</button>
        <button onClick={() => setChannel('wb')} style={chanBtn(channel === 'wb')}>Mi WhatsApp</button>
      </div>

      {channel === 'vambe' ? (
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            background: 'rgba(0,0,0,0.25)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.14)',
            fontSize: 13,
            maxWidth: 230,
          }}
        >
          <option value="">{templates.length ? 'Elige plantilla…' : 'Cargando plantillas…'}</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      ) : (
        <span style={{ fontSize: 12, color: '#9aa0b4' }}>Tu plantilla fija, desde tu WhatsApp</span>
      )}

      <button
        onClick={send}
        disabled={sending}
        style={{
          padding: '9px 18px',
          borderRadius: 8,
          background: sending ? '#3a3a48' : 'linear-gradient(90deg,#7c6af7,#4ea8f5)',
          color: '#fff',
          border: 'none',
          fontWeight: 700,
          fontSize: 14,
          cursor: sending ? 'default' : 'pointer',
        }}
      >
        {sending
          ? progress
            ? `Enviando ${progress.done}/${progress.total}…`
            : 'Enviando…'
          : `Enviar a ${n}`}
      </button>

      {result && <span style={{ fontSize: 13, color: '#22d68a', fontWeight: 600 }}>{result}</span>}

      <button
        onClick={onDone}
        title="Cancelar selección"
        style={{ background: 'transparent', border: 'none', color: '#9aa0b4', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
      >
        ✕
      </button>
    </div>
  )
}
