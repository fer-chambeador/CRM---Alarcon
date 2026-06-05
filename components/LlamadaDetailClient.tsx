'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sidebar } from './CommandCenter'
import styles from './LlamadaDetailClient.module.css'

type CustomAnalysis = {
  outcome?: string | null
  puesto_buscado?: string | null
  zona_ubicacion?: string | null
  presupuesto_paquete?: string | null
  // Dapta puede mandar objeciones como string CSV ("caro, sin presupuesto") O
  // como array (["caro", "sin presupuesto"]). Tratamos ambos.
  objeciones?: string[] | string | null
  usa_otra_plataforma?: string | null
  interes_real?: 'alto' | 'medio' | 'bajo' | null
  proximo_paso?: string | null
  resumen_detallado?: string | null
  agendar_seguimiento?: string | null
  sentimiento?: 'positivo' | 'neutral' | 'negativo' | null
}

// Normaliza objeciones a array sin importar cómo venga de Dapta.
// Causaba 'client-side exception' cuando llegaba como string (Dapta a veces
// devuelve "obj1, obj2, obj3" en lugar de array): .map() crasheaba.
function normalizeObjeciones(raw: string[] | string | null | undefined): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
  if (typeof raw === 'string') {
    return raw.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)
  }
  return []
}

type Llamada = {
  id: string
  lead_id: string | null
  dapta_call_id: string | null
  agent_name: string | null
  status: string
  outcome: string | null
  to_number: string
  from_number: string | null
  duration_seconds: number | null
  recording_url: string | null
  transcript: Array<{ speaker?: string; text?: string; timestamp?: string }> | null
  summary: string | null
  custom_analysis: CustomAnalysis | null
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
  leads: {
    id: string
    nombre: string | null
    email: string | null
    empresa: string | null
    telefono: string | null
    status: string
    presupuesto: string | null
    vacante: string | null
    notas: string | null
    canal_adquisicion: string | null
  } | null
}

function fmtDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })
}
function fmtDuration(s: number | null): string {
  if (!s) return '—'
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function LlamadaDetailClient({ id }: { id: string }) {
  const router = useRouter()
  const [llamada, setLlamada] = useState<Llamada | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancel = false
    async function run() {
      setLoading(true)
      try {
        const res = await fetch(`/api/llamadas/${id}`, { cache: 'no-store' })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          if (!cancel) setError(j.error || `HTTP ${res.status}`)
          return
        }
        const j = await res.json()
        if (!cancel) setLlamada(j as Llamada)
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancel) setLoading(false)
      }
    }
    run()
    return () => { cancel = true }
  }, [id])

  if (loading) return <Shell><div className={styles.empty}>Cargando…</div></Shell>
  if (error) return <Shell><div className={styles.empty}>Error: {error}</div></Shell>
  if (!llamada) return <Shell><div className={styles.empty}>Llamada no encontrada</div></Shell>

  const ca = llamada.custom_analysis || {}
  const lead = llamada.leads

  return (
    <Shell title={`Llamada · ${lead?.nombre || lead?.email || llamada.to_number}`}>
      <div className={styles.body}>
        <div className={styles.col}>
          {/* Resumen */}
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>Resumen</h3>
            {llamada.summary
              ? <p className={styles.summary}>{llamada.summary}</p>
              : <p className={styles.empty}>Sin resumen — la llamada {llamada.status === 'completed' ? 'no devolvió análisis' : `está en estado "${llamada.status}"`}.</p>}
            {ca.resumen_detallado && ca.resumen_detallado !== llamada.summary && (
              <>
                <h3 className={styles.cardTitle} style={{ marginTop: 18 }}>Detalle</h3>
                <p className={styles.summary}>{ca.resumen_detallado}</p>
              </>
            )}
          </div>

          {/* Audio */}
          {llamada.recording_url && (
            <div className={styles.card}>
              <h3 className={styles.cardTitle}>Grabación</h3>
              <audio controls src={llamada.recording_url} className={styles.audio} />
            </div>
          )}

          {/* Transcript */}
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>Transcript</h3>
            {llamada.transcript && llamada.transcript.length > 0 ? (
              <div className={styles.transcript}>
                {llamada.transcript.map((t, i) => {
                  // Dapta/Daniela usa { role: 'agent'|'user', content: '...' }
                  // pero el typedef antiguo asumía { speaker, text }. Soportamos AMBOS
                  // para no perder render con la estructura real que llega.
                  const tt = t as { role?: string; speaker?: string; content?: string; text?: string }
                  const rawSpeaker = (tt.speaker || tt.role || '').toLowerCase()
                  const text = tt.text || tt.content || ''
                  const isAgent = rawSpeaker.includes('agent') || rawSpeaker.includes('daniela') || rawSpeaker.includes('ai') || rawSpeaker === 'assistant'
                  const displaySpeaker = tt.speaker || (isAgent ? 'Daniela' : 'Cliente')
                  return (
                    <div key={i} className={`${styles.turn} ${isAgent ? styles.turnAgent : styles.turnUser}`}>
                      <div className={styles.turnSpeaker}>{displaySpeaker}</div>
                      <div>{text || <span style={{ opacity: 0.5, fontStyle: 'italic' }}>(sin texto)</span>}</div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className={styles.empty}>Sin transcript disponible.</p>
            )}
          </div>
        </div>

        <div className={styles.col}>
          {/* Lead */}
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>Lead</h3>
            <div className={styles.leadName}>{lead?.nombre || lead?.email || '—'}</div>
            <div className={styles.leadMeta}>{lead?.empresa || '—'}</div>
            <div style={{ marginTop: 14 }}>
              <FieldRow label="Email" value={lead?.email || '—'} mono />
              <FieldRow label="Teléfono" value={llamada.to_number} mono />
              <FieldRow label="Vacante" value={lead?.vacante || '—'} />
              <FieldRow label="Presupuesto" value={lead?.presupuesto || '—'} />
              <FieldRow label="Status" value={lead?.status || '—'} />
              <FieldRow label="Canal" value={lead?.canal_adquisicion || '—'} />
            </div>
            {lead && (
              <button className={styles.backBtn} onClick={() => router.push(`/leads/${lead.id}`)} style={{ marginTop: 14 }}>
                Ver lead en CRM →
              </button>
            )}
          </div>

          {/* Accionables */}
          {(llamada.pidio_link_pago || llamada.pidio_presentacion || llamada.agendar_seguimiento) && (
            <div className={styles.card}>
              <h3 className={styles.cardTitle}>Acciones requeridas</h3>
              <div className={styles.accionables}>
                {llamada.pidio_link_pago && (
                  <div className={styles.accBadge}>
                    💰 Pidió liga de pago / transferencia
                    <div className={styles.accBadgeText}>Mandá la liga por WhatsApp YA. Daniela ya le dijo que llega en unos minutos.</div>
                  </div>
                )}
                {llamada.pidio_presentacion && (
                  <div className={`${styles.accBadge} ${styles.accBadgePurple}`}>
                    📋 Pidió la presentación comercial
                    <div className={styles.accBadgeText}>Mandá el PDF + agendá follow-up.</div>
                  </div>
                )}
                {llamada.agendar_seguimiento && (
                  <div className={`${styles.accBadge} ${styles.accBadgePurple}`}>
                    📅 Seguimiento agendado
                    <div className={styles.accBadgeText}>{fmtDate(llamada.agendar_seguimiento)}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Análisis */}
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>Análisis post-call</h3>
            <FieldRow label="Outcome" value={ca.outcome || '—'} />
            <FieldRow label="Interés" value={ca.interes_real || '—'} />
            <FieldRow label="Sentimiento" value={ca.sentimiento || '—'} />
            <FieldRow label="Puesto buscado" value={ca.puesto_buscado || '—'} />
            <FieldRow label="Zona" value={ca.zona_ubicacion || '—'} />
            <FieldRow label="Paquete" value={ca.presupuesto_paquete || '—'} />
            {ca.usa_otra_plataforma && <FieldRow label="Otra plataforma" value={ca.usa_otra_plataforma} />}
            {ca.proximo_paso && (
              <div style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 8, fontSize: 13 }}>
                <div className={styles.muted} style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Próximo paso</div>
                {ca.proximo_paso}
              </div>
            )}
            {(() => {
              const objs = normalizeObjeciones(ca.objeciones)
              if (objs.length === 0) return null
              return (
                <div style={{ marginTop: 12 }}>
                  <div className={styles.muted} style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Objeciones</div>
                  <div className={styles.objeciones}>
                    {objs.map((o, i) => <span key={i} className={styles.objChip}>{o}</span>)}
                  </div>
                </div>
              )
            })()}
          </div>

          {/* Metadata */}
          <div className={styles.card}>
            <h3 className={styles.cardTitle}>Metadata</h3>
            <FieldRow label="Agente" value={llamada.agent_name || '—'} />
            <FieldRow label="Status" value={llamada.status} />
            <FieldRow label="Duración" value={fmtDuration(llamada.duration_seconds)} mono />
            <FieldRow label="Inicio" value={fmtDate(llamada.started_at)} />
            <FieldRow label="Fin" value={fmtDate(llamada.ended_at)} />
            <FieldRow label="Creada" value={fmtDate(llamada.created_at)} />
            <FieldRow label="Disparada por" value={llamada.triggered_by || '—'} />
            <FieldRow label="Razón" value={llamada.trigger_reason || '—'} />
            {llamada.dapta_call_id && <FieldRow label="Dapta ID" value={llamada.dapta_call_id} mono />}
            {llamada.error_message && <FieldRow label="Error" value={llamada.error_message} />}
          </div>
        </div>
      </div>
    </Shell>
  )

  function Shell({ children, title }: { children: React.ReactNode; title?: string }) {
    return (
      <div className={styles.root}>
        <aside className={styles.sidebar}>
          <div className={styles.logo}><span style={{ fontSize: 22 }}>⚡</span><span>Chambas CRM</span></div>
          <Sidebar active="llamadas" />
        </aside>
        <main className={styles.main}>
          <div className={styles.topBar}>
            <button className={styles.backBtn} onClick={() => router.push('/llamadas')}>← Llamadas</button>
            <h1 className={styles.title}>{title || 'Llamada'}</h1>
            <span className={styles.spacer} />
          </div>
          {children}
        </main>
      </div>
    )
  }
}

function FieldRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.fieldRow}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={`${styles.fieldValue} ${mono ? styles.mono : ''}`}>{value}</span>
    </div>
  )
}
