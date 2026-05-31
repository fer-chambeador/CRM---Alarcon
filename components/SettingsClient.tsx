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

type ImportResult = {
  ok: boolean
  events_scanned?: number
  leads_matched?: number
  leads_updated?: number
  leads_created?: number
  error?: string
}

type VambeTemplate = {
  id: string
  name?: string
  status?: string
  language?: string
  body?: string
}
type OutboundTemplateResp = {
  current: { template_id: string; template_name: string } | null
  templates: VambeTemplate[]
  error?: string
}

export default function SettingsClient() {
  const params = useSearchParams()
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [flash, setFlash] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [tplData, setTplData] = useState<OutboundTemplateResp | null>(null)
  const [tplSaving, setTplSaving] = useState(false)
  const [tplFilter, setTplFilter] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/integrations/google/status', { cache: 'no-store' })
      const data = await res.json()
      setStatus(data)
    } finally { setLoading(false) }
  }

  const importCalendar = async () => {
    setImporting(true); setImportResult(null)
    try {
      const res = await fetch('/api/integrations/google/import', { method: 'POST' })
      const data = await res.json()
      setImportResult(data)
    } catch (e) {
      setImportResult({ ok: false, error: e instanceof Error ? e.message : 'falló' })
    } finally { setImporting(false) }
  }

  const loadTemplates = async () => {
    try {
      const res = await fetch('/api/settings/outbound-template', { cache: 'no-store' })
      const data = await res.json() as OutboundTemplateResp
      setTplData(data)
    } catch (e) { console.error(e) }
  }

  const saveTemplate = async (tpl: VambeTemplate) => {
    setTplSaving(true)
    try {
      const res = await fetch('/api/settings/outbound-template', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template_id: tpl.id, template_name: tpl.name }),
      })
      if (res.ok) {
        setFlash(`✓ Template outbound: ${tpl.name}`)
        setTimeout(() => setFlash(null), 4000)
      }
      await loadTemplates()
    } finally { setTplSaving(false) }
  }

  useEffect(() => { load(); loadTemplates() }, [])

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
                    <>
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

                      {/* Import del Calendar al CRM */}
                      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                        <div style={{ fontSize: 13.5, color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}>
                          Importar llamadas del Calendar
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
                          Trae las próximas llamadas (30 días) de tu Calendar y las vincula con leads del CRM
                          que coincidan por email. No toca las llamadas ya vinculadas.
                        </div>
                        <button onClick={importCalendar} disabled={importing}
                          style={{
                            background: 'linear-gradient(90deg, #4ea8f5, #7c6af7)',
                            color: 'white', border: 'none',
                            padding: '9px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                            cursor: importing ? 'wait' : 'pointer', fontFamily: 'var(--font)',
                          }}>
                          {importing ? '↻ Importando…' : '⇣ Importar próximas llamadas'}
                        </button>

                        {importResult && (
                          <div style={{ marginTop: 12 }}>
                            {importResult.ok
                              ? (
                                <div style={{
                                  background: 'rgba(34,214,138,0.08)',
                                  border: '1px solid rgba(34,214,138,0.25)',
                                  borderRadius: 8, padding: '10px 14px', fontSize: 12.5, color: 'var(--text)',
                                }}>
                                  ✓ {importResult.events_scanned} eventos ·{' '}
                                  <strong style={{ color: '#22d68a' }}>{importResult.leads_updated || 0}</strong> leads existentes actualizados ·{' '}
                                  <strong style={{ color: '#4ea8f5' }}>{importResult.leads_created || 0}</strong> leads nuevos creados
                                </div>
                              )
                              : (
                                <div style={{
                                  background: 'rgba(240,90,90,0.08)',
                                  border: '1px solid rgba(240,90,90,0.25)',
                                  borderRadius: 8, padding: '10px 14px', fontSize: 12.5, color: '#f05a5a',
                                }}>
                                  ⚠️ {importResult.error}
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                    </>
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

          {/* ─── Templates Outbound ────────────────────────────────────── */}
          <section style={{
            background: 'var(--glass)', border: '1px solid var(--border)',
            borderRadius: 14, padding: '20px 24px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>📨</span>
              <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>
                Template Outbound (Vambe)
              </h2>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 14 }}>
              Cuando apruebas un lead en <strong>Outbound → Mensajes</strong>, se manda esta plantilla por Vambe.
              La variable <code>{'{{empresa}}'}</code> se llena automáticamente con el nombre de la empresa del lead.
            </p>

            {tplData?.current && (
              <div style={{
                background: 'rgba(124,84,232,0.10)',
                border: '1px solid rgba(124,84,232,0.35)',
                borderRadius: 8, padding: '10px 14px', fontSize: 13,
                marginBottom: 14,
              }}>
                <div style={{ color: '#b8a3ff', fontWeight: 600 }}>Activo: {tplData.current.template_name}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                  ID: {tplData.current.template_id}
                </div>
              </div>
            )}

            {tplData?.error && (
              <div style={{
                background: 'rgba(245,200,66,0.08)',
                border: '1px solid rgba(245,200,66,0.3)',
                color: '#f5c842', padding: '10px 14px', borderRadius: 8, fontSize: 12.5,
                marginBottom: 14,
              }}>⚠️ {tplData.error}</div>
            )}

            <input
              value={tplFilter}
              onChange={e => setTplFilter(e.target.value)}
              placeholder="Buscar template por nombre…"
              style={{
                width: '100%', padding: '8px 12px',
                background: 'var(--glass2, rgba(0,0,0,0.2))',
                border: '1px solid var(--border)',
                borderRadius: 8, fontSize: 13, color: 'var(--text)',
                fontFamily: 'var(--font)', marginBottom: 10,
              }}
            />

            <div style={{
              maxHeight: 360, overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}>
              {(tplData?.templates || [])
                .filter(t => !tplFilter || (t.name || '').toLowerCase().includes(tplFilter.toLowerCase()))
                .map(t => {
                  const isCurrent = tplData?.current?.template_id === t.id
                  return (
                    <div key={t.id} style={{
                      padding: '10px 14px',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 12,
                      background: isCurrent ? 'rgba(124,84,232,0.06)' : 'transparent',
                    }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                          {t.name || '(sin nombre)'}
                          {t.status === 'APPROVED' && <span style={{ marginLeft: 8, fontSize: 10, color: '#22d68a' }}>✓ APPROVED</span>}
                          {t.status && t.status !== 'APPROVED' && <span style={{ marginLeft: 8, fontSize: 10, color: '#f5c842' }}>· {t.status}</span>}
                        </div>
                        {t.body && (
                          <div style={{
                            fontSize: 11, color: 'var(--text3)', marginTop: 4,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            fontFamily: 'var(--mono)',
                          }}>{t.body.slice(0, 120)}</div>
                        )}
                      </div>
                      <button
                        disabled={tplSaving || isCurrent}
                        onClick={() => saveTemplate(t)}
                        style={{
                          padding: '6px 12px', borderRadius: 6,
                          border: isCurrent ? '1px solid rgba(124,84,232,0.35)' : '1px solid var(--border2)',
                          background: isCurrent ? 'rgba(124,84,232,0.15)' : 'transparent',
                          color: isCurrent ? '#b8a3ff' : 'var(--text2)',
                          fontSize: 12, fontWeight: 600,
                          cursor: isCurrent ? 'default' : 'pointer',
                          fontFamily: 'var(--font)',
                          flexShrink: 0,
                        }}>
                        {isCurrent ? '✓ Activo' : 'Seleccionar'}
                      </button>
                    </div>
                  )
                })}
              {(!tplData || tplData.templates.length === 0) && (
                <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>
                  Cargando templates de Vambe…
                </div>
              )}
            </div>
          </section>

        </div>
      </main>
    </div>
  )
}
