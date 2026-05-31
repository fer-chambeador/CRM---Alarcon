'use client'

import { useEffect, useState, useCallback } from 'react'
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

export default function AprobacionesClient() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string, 'approve' | 'reject' | null>>({})

  const fetchData = useCallback(async () => {
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

  useEffect(() => { fetchData() }, [fetchData])

  // Refresh cada 30s para mantener la lista al día (en realidad un realtime
  // sub sería más limpio, pero el polling cubre el caso del 99% sin cost extra)
  useEffect(() => {
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [fetchData])

  const approve = async (id: string, daptaImmediate = false) => {
    setBusy(s => ({ ...s, [id]: 'approve' }))
    try {
      const res = await fetch(`/api/aprobaciones/${id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dapta_immediate: daptaImmediate }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert('Falló: ' + (err.error || res.status))
      }
      await fetchData()
    } finally {
      setBusy(s => ({ ...s, [id]: null }))
    }
  }

  const reject = async (id: string) => {
    if (!confirm('¿Marcar como "lo hago manual"? Ya no se sugerirá de nuevo.')) return
    setBusy(s => ({ ...s, [id]: 'reject' }))
    try {
      await fetch(`/api/aprobaciones/${id}/reject`, { method: 'POST' })
      await fetchData()
    } finally {
      setBusy(s => ({ ...s, [id]: null }))
    }
  }

  return (
    <div className={styles.layout}>
      <Sidebar active="aprobaciones" />
      <main className={styles.main}>
        <header className={styles.header}>
          <h1 className={styles.h1}>✋ Aprobaciones</h1>
          <button className={styles.btnGhost} onClick={fetchData}>↻ Refresh</button>
        </header>

        {loading && <p style={{ opacity: 0.6 }}>Cargando…</p>}

        {!loading && data && data.counts.total === 0 && (
          <div style={{ padding: 40, textAlign: 'center', opacity: 0.6 }}>
            <p style={{ fontSize: 18 }}>🎉 Nada pendiente</p>
            <p style={{ fontSize: 13 }}>El scanner corre cada 15 min. Cuando aparezcan leads nuevos que califiquen, los verás aquí.</p>
          </div>
        )}

        {!loading && data && data.vambe.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>
              📨 Mensajes Vambe pendientes <span style={{ opacity: 0.5 }}>({data.vambe.length})</span>
            </h2>
            <p style={{ opacity: 0.6, fontSize: 13, marginBottom: 16 }}>
              Leads inbound de baja calificación con 30+ min sin contactar. Apruebas → se manda
              el template <code>outbound_primer_mensaje_sales</code> con la variable <code>empresa</code>.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {data.vambe.map(a => (
                <AprobacionCard
                  key={a.id}
                  apro={a}
                  busy={busy[a.id]}
                  onApprove={() => approve(a.id)}
                  onReject={() => reject(a.id)}
                  approveLabel="📨 Mandar mensaje Vambe"
                  approveTooltip={`Template: ${a.template_name || '(no configurado)'} · empresa: ${a.leads?.empresa || '(vacío)'}`}
                />
              ))}
            </div>
          </section>
        )}

        {!loading && data && data.dapta.length > 0 && (
          <section>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>
              📞 Llamadas Dapta pendientes <span style={{ opacity: 0.5 }}>({data.dapta.length})</span>
            </h2>
            <p style={{ opacity: 0.6, fontSize: 13, marginBottom: 16 }}>
              Leads de baja calificación con llamada agendada. Apruebas →
              Daniela (Dapta) llama a la hora del lead. O eliges <em>Yo manual</em>.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {data.dapta.map(a => (
                <AprobacionCard
                  key={a.id}
                  apro={a}
                  busy={busy[a.id]}
                  onApprove={() => approve(a.id)}
                  onReject={() => reject(a.id)}
                  approveLabel="📞 Sí, Dapta llama a la hora"
                  approveTooltip={`Daniela llamará el ${a.scheduled_at ? new Date(a.scheduled_at).toLocaleString('es-MX') : 'horario lead'}`}
                />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function AprobacionCard({
  apro, busy, onApprove, onReject, approveLabel, approveTooltip,
}: {
  apro: Aprobacion
  busy: 'approve' | 'reject' | null | undefined
  onApprove: () => void
  onReject: () => void
  approveLabel: string
  approveTooltip: string
}) {
  const lead = apro.leads
  return (
    <div style={{
      border: '1px solid var(--border, rgba(255,255,255,0.1))',
      borderRadius: 10,
      padding: 16,
      background: 'rgba(255,255,255,0.02)',
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: 16,
      alignItems: 'center',
    }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
          {lead?.nombre || lead?.empresa || lead?.email || '(sin nombre)'}
          {apro.score_snapshot !== null && (
            <span style={{ marginLeft: 10, fontSize: 12, opacity: 0.6 }}>
              · score {apro.score_snapshot} pts
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.5 }}>
          {lead?.empresa && <span>🏢 {lead.empresa}</span>}
          {lead?.empresa && lead?.vacante && <span> · </span>}
          {lead?.vacante && <span>💼 {lead.vacante}</span>}
          {lead?.telefono && <span> · 📱 {lead.telefono}</span>}
        </div>
        {lead?.email && (
          <div style={{ fontSize: 12, opacity: 0.55, marginTop: 2 }}>{lead.email}</div>
        )}
        {apro.reason && (
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6, fontStyle: 'italic' }}>
            💡 {apro.reason}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch', minWidth: 220 }}>
        <button
          disabled={!!busy}
          onClick={onApprove}
          title={approveTooltip}
          style={{
            padding: '8px 14px',
            background: 'linear-gradient(135deg, #7c54e8, #5a3fc4)',
            border: 'none',
            borderRadius: 6,
            color: 'white',
            fontWeight: 600,
            fontSize: 13,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy === 'approve' ? 0.5 : 1,
          }}
        >
          {busy === 'approve' ? '⏳ Disparando…' : approveLabel}
        </button>
        <button
          disabled={!!busy}
          onClick={onReject}
          style={{
            padding: '7px 14px',
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 6,
            color: 'rgba(255,255,255,0.75)',
            fontSize: 12,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy === 'reject' ? 0.5 : 1,
          }}
        >
          {busy === 'reject' ? '⏳ Marcando…' : '✋ Lo hago manual'}
        </button>
      </div>
    </div>
  )
}
