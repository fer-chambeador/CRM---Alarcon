'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Sidebar } from './CommandCenter'
import styles from './CRMClient.module.css'

type GoogleStatus = {
  connected: boolean
  google_email: string | null
  has_credentials: boolean
}

export default function SettingsClient() {
  const params = useSearchParams()
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [flash, setFlash] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/integrations/google/status', { cache: 'no-store' })
      const data = await res.json()
      setStatus(data)
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const g = params.get('google')
    if (g === 'connected') setFlash('✓ Google Calendar conectado')
    if (g === 'error') setFlash('⚠️ Error: ' + (params.get('msg') || 'unknown'))
    if (g) setTimeout(() => setFlash(null), 6000)
  }, [params])

  const connect = () => {
    window.location.href = '/api/integrations/google/authorize'
  }
  const disconnect = async () => {
    if (!confirm('¿Desconectar Google Calendar? Los eventos ya creados no se borran de tu Calendar.')) return
    await fetch('/api/integrations/google/disconnect', { method: 'POST' })
    load()
  }

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="leads" />
      </aside>
      <main className={styles.main}>
        <div className={styles.topBar}>
          <h1 className={styles.pageTitle}>⚙ Settings</h1>
        </div>
        <div style={{ padding: '0 32px 32px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
          {flash && (
            <div style={{
              background: flash.startsWith('✓') ? 'rgba(34,214,138,0.1)' : 'rgba(240,90,90,0.1)',
              border: `1px solid ${flash.startsWith('✓') ? 'rgba(34,214,138,0.3)' : 'rgba(240,90,90,0.3)'}`,
              color: flash.startsWith('✓') ? '#22d68a' : '#f05a5a',
              padding: '10px 14px', borderRadius: 8, fontSize: 13,
            }}>{flash}</div>
          )}

          {/* Google Calendar */}
          <section style={{
            background: 'var(--glass)', border: '1px solid var(--border)',
            borderRadius: 14, padding: '20px 24px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>📅</span>
              <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>
                Google Calendar
              </h2>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 14 }}>
              Sincroniza automáticamente las llamadas agendadas de tus leads con tu Google Calendar.
              Cuando un lead pone fecha/hora en el onboarding, aparece como evento en tu calendar.
              Si lo cancelas o reagendas en el CRM, el evento se actualiza solo.
            </p>

            {loading
              ? <div style={{ fontSize: 13, color: 'var(--text3)' }}>Cargando estado…</div>
              : !status?.has_credentials
                ? (
                  <div style={{
                    background: 'rgba(245,200,66,0.08)', border: '1px solid rgba(245,200,66,0.3)',
                    color: '#f5c842', padding: '10px 14px', borderRadius: 8, fontSize: 12.5,
                  }}>
                    ⚠️ Faltan credenciales de Google OAuth en Railway. Ver instrucciones de setup abajo.
                  </div>
                )
                : status.connected
                  ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                      <div>
                        <div style={{ color: '#22d68a', fontSize: 13, fontWeight: 600 }}>✓ Conectado</div>
                        {status.google_email && (
                          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>{status.google_email}</div>
                        )}
                      </div>
                      <button onClick={disconnect}
                        style={{
                          background: 'transparent', border: '1px solid var(--border2)',
                          color: 'var(--text2)', padding: '8px 16px', borderRadius: 'var(--radius-pill)',
                          fontSize: 12.5, cursor: 'pointer', fontFamily: 'var(--font)',
                        }}>
                        Desconectar
                      </button>
                    </div>
                  )
                  : (
                    <button onClick={connect}
                      style={{
                        background: 'white', color: '#1a1a2e', border: 'none',
                        padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                        cursor: 'pointer', fontFamily: 'var(--font)',
                        display: 'inline-flex', alignItems: 'center', gap: 8,
                      }}>
                      <span>🔗</span> Conectar Google Calendar
                    </button>
                  )}
          </section>

          {/* Setup guide */}
          <section style={{
            background: 'var(--glass)', border: '1px solid var(--border)',
            borderRadius: 14, padding: '20px 24px',
          }}>
            <h3 style={{ margin: '0 0 12px', fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
              Setup de Google Calendar (one-time)
            </h3>
            <ol style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7, paddingLeft: 20 }}>
              <li>Andá a <a href="https://console.cloud.google.com/" target="_blank" rel="noopener" style={{ color: 'var(--accent2)' }}>Google Cloud Console</a> y creá un proyecto (si no tenés uno).</li>
              <li>APIs & Services → Library → buscá <strong>Google Calendar API</strong> → Enable.</li>
              <li>APIs & Services → OAuth consent screen → External → completá los campos básicos + agregá tu email como test user.</li>
              <li>APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application.</li>
              <li>En <strong>Authorized redirect URIs</strong> pegá: <code style={{ background: 'var(--bg2)', padding: '2px 6px', borderRadius: 4, fontSize: 11.5 }}>https://crm-alarcon-production.up.railway.app/api/integrations/google/callback</code></li>
              <li>Copiá el <strong>Client ID</strong> y <strong>Client Secret</strong>.</li>
              <li>En Railway → Variables, agregá:
                <ul style={{ marginTop: 6 }}>
                  <li><code>GOOGLE_OAUTH_CLIENT_ID</code> = el client ID</li>
                  <li><code>GOOGLE_OAUTH_CLIENT_SECRET</code> = el client secret</li>
                  <li><code>GOOGLE_OAUTH_REDIRECT_URI</code> = la misma URL del paso 5</li>
                </ul>
              </li>
              <li>Esperá ~30s al redeploy, refrescá esta página y clickeá "Conectar".</li>
            </ol>
          </section>
        </div>
      </main>
    </div>
  )
}
