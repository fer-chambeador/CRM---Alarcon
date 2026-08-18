'use client'
import { useEffect, useState } from 'react'

type St = { ready?: boolean; linked_as?: string | null; error?: boolean }

const BRIDGES = [
  { key: 'fer', label: 'WhatsApp de Fer', url: 'https://striking-emotion-production-f75a.up.railway.app' },
  { key: 'moises', label: 'WhatsApp de Moises', url: 'https://prolific-nourishment-production-a95e.up.railway.app' },
]

export default function WaSettingsPage() {
  const [status, setStatus] = useState<Record<string, St | undefined>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    for (const b of BRIDGES) {
      try {
        const r = await fetch(`/api/wa/status?which=${b.key}`, { cache: 'no-store' })
        const j = await r.json()
        setStatus((s) => ({ ...s, [b.key]: j }))
      } catch {
        setStatus((s) => ({ ...s, [b.key]: { error: true } }))
      }
    }
  }
  useEffect(() => { load() }, [])

  const desconectar = async (key: string) => {
    if (!confirm('Desconectar este WhatsApp? Tendras que volver a escanear el QR para reconectarlo.')) return
    setBusy(key)
    try {
      await fetch(`/api/wa/relink?which=${key}`, { cache: 'no-store' })
      alert('Desconectado. Abre "Conectar / Ver QR" y escanea de nuevo con ese celular.')
    } finally {
      setBusy(null)
      setTimeout(load, 2500)
    }
  }

  return (
    <div style={{ padding: 32, maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>WhatsApp — Conexiones</h1>
      <p style={{ opacity: 0.7, fontSize: 14, marginBottom: 24 }}>
        Conecta o desconecta los numeros desde los que el CRM manda mensajes.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {BRIDGES.map((b) => {
          const st = status[b.key]
          const ready = !!(st && st.ready)
          return (
            <div key={b.key} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, background: 'var(--glass)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{b.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: ready ? '#22d68a' : '#e0574a' }}>
                  {!st ? '...' : ready ? (st.linked_as ? 'Conectado - ' + st.linked_as : 'Conectado') : 'Desconectado'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <a href={b.url} target="_blank" rel="noreferrer" style={{ background: 'linear-gradient(135deg,#22d68a,#1ab574)', color: '#fff', textDecoration: 'none', padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700 }}>Conectar / Ver QR</a>
                <button onClick={() => desconectar(b.key)} disabled={busy === b.key} style={{ background: 'transparent', color: '#e0574a', border: '1px solid #e0574a', padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: busy === b.key ? 0.5 : 1 }}>{busy === b.key ? 'Desconectando...' : 'Desconectar'}</button>
              </div>
            </div>
          )
        })}
      </div>
      <button onClick={load} style={{ marginTop: 20, background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', padding: '8px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Actualizar estado</button>
    </div>
  )
}
