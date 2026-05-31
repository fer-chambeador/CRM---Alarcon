'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Sidebar } from './CommandCenter'
import styles from './LeadDetailClient.module.css'
import { STATUS_LABELS, statusColor, fmtMoney } from '@/lib/status'
import type { Lead } from '@/lib/supabase'
import { format, formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'

type Actividad = {
  id: string
  lead_id: string
  tipo: string
  descripcion: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

type ActivityIcon = { icon: string; label: string; color: string }
const ACTIVITY_TYPES: Record<string, ActivityIcon> = {
  vambe_form_received:     { icon: '📋', label: 'Form recibido',         color: '#7c54e8' },
  vambe_lead_promoted:     { icon: '🚀', label: 'Promovido a CRM',       color: '#00c8a0' },
  vambe_stage_change:      { icon: '🔁', label: 'Cambio de stage Vambe', color: '#a07df5' },
  vambe_message:           { icon: '💬', label: 'Mensaje Vambe',         color: '#3b82f6' },
  vambe_template_sent:     { icon: '📨', label: 'Template enviado',      color: '#ffb800' },
  vambe_backfill_created:  { icon: '⬇️', label: 'Importado de Vambe',    color: '#00c8a0' },
  vambe_backfill_update:   { icon: '🔄', label: 'Actualizado (backfill)', color: '#7c54e8' },
  slack_update:            { icon: '#',  label: 'Slack',                 color: '#3b82f6' },
  status_change:           { icon: '🏷️', label: 'Cambio de status',       color: '#a07df5' },
  field_change:            { icon: '✏️', label: 'Edición de campo',       color: '#a07df5' },
  note:                    { icon: '📝', label: 'Nota',                  color: '#ffb800' },
  vambe_sync:              { icon: '🔗', label: 'Sync con Vambe',         color: '#3b82f6' },
}

function iconFor(tipo: string): ActivityIcon {
  return ACTIVITY_TYPES[tipo] || { icon: '•', label: tipo, color: '#666' }
}

export default function LeadDetailClient({ leadId }: { leadId: string }) {
  const [lead, setLead] = useState<Lead | null>(null)
  const [activity, setActivity] = useState<Actividad[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetch(`/api/leads/${leadId}`).then(r => r.json()).catch(() => null),
      fetch(`/api/leads/${leadId}/actividad`).then(r => r.json()).catch(() => []),
    ]).then(([l, a]) => {
      if (cancelled) return
      setLead(l && l.id ? l : null)
      setActivity(Array.isArray(a) ? a : [])
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [leadId])

  if (loading) {
    return (
      <div className={styles.root}>
        <aside className={styles.sidebar}>
          <div className={styles.logo}>⚡ Chambas CRM</div>
          <Sidebar active="leads" />
        </aside>
        <main className={styles.main} style={{ color: 'var(--text3)' }}>Cargando…</main>
      </div>
    )
  }

  if (!lead) {
    return (
      <div className={styles.root}>
        <aside className={styles.sidebar}>
          <div className={styles.logo}>⚡ Chambas CRM</div>
          <Sidebar active="leads" />
        </aside>
        <main className={styles.main} style={{ color: 'var(--text3)' }}>
          Lead no encontrado.{' '}
          <Link href="/leads" style={{ color: 'var(--accent)' }}>← Volver a leads</Link>
        </main>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}>⚡ Chambas CRM</div>
        <Sidebar active="leads" />
      </aside>

      <main className={styles.main}>
        <div>
          <Link href="/leads" style={{ color: 'var(--text3)', fontSize: 13, textDecoration: 'none' }}>
            ← Volver a Leads
          </Link>
        </div>

        {/* Header del lead */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20 }}>
          <div>
            <h1 className={styles.pageTitle}>
              {lead.nombre || lead.email}
            </h1>
            <div style={{ marginTop: 6, fontSize: 14, color: 'var(--text2)' }}>
              {lead.empresa ? <strong style={{ color: 'var(--text)' }}>{lead.empresa}</strong> : null}
              {lead.empresa && lead.vacante ? ' · ' : null}
              {lead.vacante ? `Reclutando: ${lead.vacante}` : null}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end' }}>
            <span style={{
              background: `${statusColor(lead.status)}22`,
              color: statusColor(lead.status),
              padding: '6px 14px',
              borderRadius: 20,
              fontSize: 13,
              fontWeight: 700,
              border: `1px solid ${statusColor(lead.status)}44`,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              {STATUS_LABELS[lead.status]}
            </span>
            {/* Botón 'Ir al chat' — solo si lead vino de Vambe y tenemos vambe_contact_id */}
            {(lead.canal_adquisicion || '').toLowerCase().includes('vambe') && (lead as { vambe_contact_id?: string }).vambe_contact_id && (() => {
              const pipelineId = '66b6ff34-3ec3-4972-8b90-33a3dc4e45fd'  // Pipeline de ventas Vambe
              const contactId = (lead as { vambe_contact_id?: string }).vambe_contact_id
              const today = new Date().toISOString().slice(0, 10)
              const url = `https://app.vambeai.com/pipeline?id=${pipelineId}&startDate=${today}&chatContactId=${contactId}`
              return (
                <a href={url} target="_blank" rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'linear-gradient(135deg, #22d68a, #1ab574)',
                    color: 'white', textDecoration: 'none',
                    padding: '8px 16px', borderRadius: 8,
                    fontSize: 13, fontWeight: 700,
                  }}>
                  💬 Ir al chat ↗
                </a>
              )
            })()}
          </div>
        </header>

        {/* Grid de datos */}
        <section className={styles.dataGrid}>
          <DataCard label="Email"     value={lead.email} />
          <DataCard label="Teléfono"  value={lead.telefono} />
          <DataCard label="Canal"     value={lead.canal_adquisicion} />
          <DataCard label="Puesto"    value={lead.puesto} />
          <DataCard label="Presupuesto" value={lead.presupuesto} />
          <DataCard label="Monto"     value={fmtMoney(lead.monto)} />
          <DataCard label="Contactos" value={`${lead.veces_contactado || 0} intentos`} />
          {lead.llamada_at && <DataCard label="Llamada" value={format(new Date(lead.llamada_at), "d MMM, HH:mm", { locale: es })} />}
          {lead.tipo_llamada && <DataCard label="Tipo llamada" value={lead.tipo_llamada} />}
        </section>

        {/* Notas */}
        {lead.notas && (
          <section style={{
            background: 'var(--glass)',
            border: '1px solid var(--border)',
            borderLeft: '3px solid var(--accent)',
            borderRadius: 12,
            padding: '14px 18px',
            whiteSpace: 'pre-wrap',
            fontSize: 13.5,
            color: 'var(--text2)',
            lineHeight: 1.6,
          }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>📝 Notas</div>
            {lead.notas}
          </section>
        )}

        {/* Timeline */}
        <section>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 14 }}>
            Timeline · {activity.length} eventos
          </h2>
          {activity.length === 0 && (
            <div style={{ color: 'var(--text3)', fontSize: 13, padding: 20, background: 'var(--glass)', borderRadius: 12, textAlign: 'center' }}>
              No hay actividad registrada todavía.
            </div>
          )}
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, position: 'relative' }}>
            {/* Vertical line */}
            <div style={{
              position: 'absolute', left: 20, top: 14, bottom: 14,
              width: 2, background: 'var(--border)', borderRadius: 1,
            }} />
            {activity.map((a) => {
              const meta = iconFor(a.tipo)
              return (
                <li key={a.id} style={{ position: 'relative', paddingLeft: 56, marginBottom: 18 }}>
                  {/* Icon dot */}
                  <div style={{
                    position: 'absolute', left: 0, top: 0,
                    width: 42, height: 42, borderRadius: 21,
                    background: `${meta.color}22`,
                    border: `2px solid ${meta.color}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 18,
                  }}>{meta.icon}</div>
                  <div style={{
                    background: 'var(--glass)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: '10px 14px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                      <strong style={{ fontSize: 13, color: 'var(--text)' }}>{meta.label}</strong>
                      <time style={{ fontSize: 11, color: 'var(--text3)' }}>
                        {formatDistanceToNow(new Date(a.created_at), { addSuffix: true, locale: es })}
                      </time>
                    </div>
                    {a.descripcion && (
                      <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                        {a.descripcion}
                      </div>
                    )}
                    {a.metadata && Object.keys(a.metadata).length > 0 && (
                      <details style={{ marginTop: 6 }}>
                        <summary style={{ fontSize: 11, color: 'var(--text3)', cursor: 'pointer' }}>
                          Ver metadata
                        </summary>
                        <pre style={{
                          fontSize: 10.5, color: 'var(--text3)', fontFamily: 'var(--mono)',
                          background: 'var(--bg3)', padding: 10, borderRadius: 6,
                          marginTop: 6, overflow: 'auto', maxHeight: 200,
                        }}>
                          {JSON.stringify(a.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      </main>
    </div>
  )
}

function DataCard({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div style={{
      background: 'var(--glass)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '12px 14px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 500 }}>
        {value || '—'}
      </div>
    </div>
  )
}
