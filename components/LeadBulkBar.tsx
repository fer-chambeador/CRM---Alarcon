'use client'

/**
 * Barra flotante de envío masivo desde la tabla de Leads.
 * Aparece cuando hay ≥1 lead seleccionado.
 *
 * Tres modos:
 *  - Automático por contexto: clasifica CADA lead y dispara lo que corresponde
 *      · Reactivable (Vambe, ~3d sin contacto) → flujo de reactivación (msg predeterminado, Vambe)
 *      · No-show de llamada → plantilla de rescate (Vambe)
 *      · Contactado sin cita → plantilla de invitación a agendar (Vambe)
 *      · Nuevo / frío (nunca conversó) → primer contacto (Vambe o tu WhatsApp)
 *      · Cerrado / a mitad de embudo → se omite (no pisar conversación)
 *  - Vambe: una sola plantilla elegida a todos, por Vambe.
 *  - Mi WhatsApp: mensaje fijo desde tu número (WA Bridge).
 */

import { useEffect, useMemo, useState } from 'react'
import type { Lead } from '@/lib/supabase'
import { canReactivateVambe3d } from '@/lib/leadVambe'

type Tpl = { id: string; name: string; preview: string; category: string }

const STAGE_INTERESADO = '96c42cda-2828-45db-973c-3bc63a8141fd'
const CLOSED = ['convertido', 'cliente_recurrente', 'descartado']

type Bucket = 'reactivar' | 'rescate' | 'agendar' | 'primer' | 'skip'

function classify(lead: Lead): Bucket {
  const st = String(lead.status || '')
  if (CLOSED.includes(st)) return 'skip'
  if (st === 'no_show_llamada') return 'rescate'
  if (canReactivateVambe3d(lead)) return 'reactivar'
  if (st === 'nuevo') return 'primer'
  if (st === 'contactado') return 'agendar'
  return 'skip'
}

export function LeadBulkBar({
  selectedIds,
  leads,
  onDone,
}: {
  selectedIds: Set<string>
  leads: Lead[]
  onDone: () => void
}) {
  const [templates, setTemplates] = useState<Tpl[]>([])
  const [mode, setMode] = useState<'auto' | 'vambe' | 'wb'>('auto')
  const [coldChannel, setColdChannel] = useState<'vambe' | 'wb'>('vambe')
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

  const chosen = useMemo(
    () => leads.filter((l) => selectedIds.has(l.id) && l.telefono),
    [leads, selectedIds],
  )
  const sinTel = selectedIds.size - chosen.length

  // Plan por contexto (para el desglose en vivo del modo automático)
  const plan = useMemo(() => {
    const b: Record<Bucket, Lead[]> = { reactivar: [], rescate: [], agendar: [], primer: [], skip: [] }
    for (const l of chosen) b[classify(l)].push(l)
    return b
  }, [chosen])

  if (selectedIds.size === 0) return null

  const findTpl = (exact: string, kw: string) =>
    templates.find((t) => t.name === exact) || templates.find((t) => new RegExp(kw, 'i').test(t.name)) || null

  const primerTpl = findTpl('outbound_primer_mensaje_sales', 'primer|bienvenida|outbound_enero')
  const rescateTpl = findTpl('rescate_asistencia_humana', 'rescate')
  const agendarTpl = findTpl('agendar_llamada_v2', 'agendar')

  async function dispatchVambe(templateId: string, list: Lead[], stageId: string) {
    let ok = 0, err = 0
    const payload = list.map((l) => ({ id: l.id, phone: l.telefono }))
    for (let i = 0; i < payload.length; i += 100) {
      const batch = payload.slice(i, i + 100)
      try {
        const res = await fetch('/api/outbound/dispatch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ templateId, stageId, leads: batch }),
        })
        const data = (await res.json().catch(() => ({}))) as { results?: { ok: boolean }[] }
        if (Array.isArray(data.results)) { for (const r of data.results) r.ok ? ok++ : err++ }
        else err += batch.length
      } catch { err += batch.length }
    }
    return { ok, err }
  }

  async function postEach(list: Lead[], url: (id: string) => string) {
    let ok = 0, err = 0
    for (const l of list) {
      try {
        const res = await fetch(url(l.id), { method: 'POST' })
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean }
        res.ok && data.ok !== false ? ok++ : err++
      } catch { err++ }
      await new Promise((r) => setTimeout(r, 350))
    }
    return { ok, err }
  }

  async function send() {
    if (chosen.length === 0) { alert('Ninguno de los seleccionados tiene teléfono.'); return }

    // ── Modo manual: una plantilla / mensaje a todos ──
    if (mode === 'vambe') {
      if (!templateId) { alert('Elige una plantilla de Vambe.'); return }
      if (!confirm(`¿Enviar esta plantilla a ${chosen.length} lead(s) por Vambe?`)) return
      setSending(true); setResult(null)
      const { ok, err } = await dispatchVambe(templateId, chosen, STAGE_INTERESADO)
      setResult(`Enviados: ${ok} · Fallidos: ${err}`); setSending(false)
      if (err === 0) setTimeout(() => { setResult(null); onDone() }, 2500)
      return
    }
    if (mode === 'wb') {
      if (!confirm(`¿Enviar tu mensaje de WhatsApp a ${chosen.length} lead(s)?`)) return
      setSending(true); setResult(null); setProgress({ done: 0, total: chosen.length })
      let ok = 0, err = 0
      for (let i = 0; i < chosen.length; i++) {
        try {
          const res = await fetch(`/api/leads/${chosen[i].id}/wa-direct`, { method: 'POST' })
          const data = (await res.json().catch(() => ({}))) as { ok?: boolean }
          res.ok && data.ok !== false ? ok++ : err++
        } catch { err++ }
        setProgress({ done: i + 1, total: chosen.length })
        await new Promise((r) => setTimeout(r, 400))
      }
      setResult(`Enviados: ${ok} · Fallidos: ${err}`); setSending(false); setProgress(null)
      if (err === 0) setTimeout(() => { setResult(null); onDone() }, 2500)
      return
    }

    // ── Modo automático por contexto ──
    const resumen = `Reactivar ${plan.reactivar.length} · Primer contacto ${plan.primer.length} · Rescate ${plan.rescate.length} · Agendar ${plan.agendar.length} · Omitidos ${plan.skip.length}`
    if (!confirm(`Envío automático por contexto:\n\n${resumen}\n\n¿Continuar? (primer contacto va por ${coldChannel === 'vambe' ? 'Vambe' : 'tu WhatsApp'})`)) return

    setSending(true); setResult(null)
    let ok = 0, err = 0, omit = plan.skip.length

    // 1. Reactivación (flujo existente, 1×1)
    if (plan.reactivar.length) {
      const r = await postEach(plan.reactivar, (id) => `/api/leads/${id}/reactivate-vambe-3d`)
      ok += r.ok; err += r.err
    }
    // 2. Rescate no-show
    if (plan.rescate.length) {
      if (rescateTpl) { const r = await dispatchVambe(rescateTpl.id, plan.rescate, ''); ok += r.ok; err += r.err }
      else omit += plan.rescate.length
    }
    // 3. Invitación a agendar
    if (plan.agendar.length) {
      if (agendarTpl) { const r = await dispatchVambe(agendarTpl.id, plan.agendar, STAGE_INTERESADO); ok += r.ok; err += r.err }
      else omit += plan.agendar.length
    }
    // 4. Primer contacto (frío)
    if (plan.primer.length) {
      if (coldChannel === 'wb') {
        const r = await postEach(plan.primer, (id) => `/api/leads/${id}/wa-direct`)
        ok += r.ok; err += r.err
      } else if (primerTpl) {
        const r = await dispatchVambe(primerTpl.id, plan.primer, STAGE_INTERESADO); ok += r.ok; err += r.err
      } else omit += plan.primer.length
    }

    setResult(`OK ${ok} · Fallidos ${err} · Omitidos ${omit}`)
    setSending(false)
    if (err === 0) setTimeout(() => { setResult(null); onDone() }, 3500)
  }

  const tab = (active: boolean) => ({
    padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer' as const,
    fontSize: 13, fontWeight: 600, background: active ? '#7c6af7' : 'transparent', color: active ? '#fff' : '#9aa0b4',
  })

  return (
    <div style={{
      position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 22, zIndex: 300,
      background: '#15151f', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 14, padding: '12px 16px',
      display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 10px 34px rgba(0,0,0,0.55)', flexWrap: 'wrap', maxWidth: '94vw',
    }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>
        {selectedIds.size} seleccionado{selectedIds.size === 1 ? '' : 's'}
        {sinTel > 0 && <span style={{ color: '#f0a15a', fontWeight: 400, fontSize: 12 }}> · {sinTel} sin tel</span>}
      </span>

      <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 8, padding: 3 }}>
        <button onClick={() => setMode('auto')} style={tab(mode === 'auto')}>Automático</button>
        <button onClick={() => setMode('vambe')} style={tab(mode === 'vambe')}>Vambe</button>
        <button onClick={() => setMode('wb')} style={tab(mode === 'wb')}>Mi WhatsApp</button>
      </div>

      {mode === 'auto' && (
        <span style={{ fontSize: 12, color: '#c9cee0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span title="Reactivación">↻ {plan.reactivar.length}</span>
          <span title="Primer contacto">✦ {plan.primer.length}</span>
          <span title="Rescate no-show">⏱ {plan.rescate.length}</span>
          <span title="Agendar">📅 {plan.agendar.length}</span>
          <span title="Omitidos" style={{ color: '#9aa0b4' }}>— {plan.skip.length}</span>
          <span style={{ color: '#9aa0b4' }}>| primer x</span>
          <button onClick={() => setColdChannel('vambe')} style={tab(coldChannel === 'vambe')}>Vambe</button>
          <button onClick={() => setColdChannel('wb')} style={tab(coldChannel === 'wb')}>WhatsApp</button>
        </span>
      )}

      {mode === 'vambe' && (
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.25)', color: '#fff', border: '1px solid rgba(255,255,255,0.14)', fontSize: 13, maxWidth: 230 }}>
          <option value="">{templates.length ? 'Elige plantilla…' : 'Cargando plantillas…'}</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}

      {mode === 'wb' && <span style={{ fontSize: 12, color: '#9aa0b4' }}>Tu mensaje fijo, desde tu WhatsApp</span>}

      <button onClick={send} disabled={sending}
        style={{ padding: '9px 18px', borderRadius: 8, background: sending ? '#3a3a48' : 'linear-gradient(90deg,#7c6af7,#4ea8f5)', color: '#fff', border: 'none', fontWeight: 700, fontSize: 14, cursor: sending ? 'default' : 'pointer' }}>
        {sending ? (progress ? `Enviando ${progress.done}/${progress.total}…` : 'Enviando…') : mode === 'auto' ? 'Enviar (auto)' : `Enviar a ${chosen.length}`}
      </button>

      {result && <span style={{ fontSize: 13, color: '#22d68a', fontWeight: 600 }}>{result}</span>}

      <button onClick={onDone} title="Cancelar selección"
        style={{ background: 'transparent', border: 'none', color: '#9aa0b4', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>✕</button>
    </div>
  )
}
