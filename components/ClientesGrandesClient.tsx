'use client'
// Clientes grandes (Fer, 7-oct-2026) — mockup 1: KPIs + filtros + tabla.
// Datos: /api/clientes-grandes (sheet 'Revenue' enero→hoy, pagos > $5,000).
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import styles from './AnalyticsClient.module.css'
import cg from './ClientesGrandesClient.module.css'
import { Sidebar } from './CommandCenter'

type Cliente = {
  key: string; empresa: string | null; email: string | null; contacto_nombre: string | null; contacto_puesto: string | null
  telefono: string | null; owner: string; total: number; pagos: number; vacantes: number; primer_pago: string | null
  ultimo_pago: string | null; canal: string | null; plan: string | null; proxima_accion: string | null
  proxima_accion_fecha: string | null; ultimo_contacto: string | null; notas: string | null
  origen: 'sheet' | 'manual'; salud: 'activo' | 'seguimiento' | 'riesgo'; lead_id: string | null
}
const OWNERS = ['Sin asignar', 'Moisés', 'Fer', 'Rodrigo', 'Marina']
const SALUD: Record<Cliente['salud'], { label: string; cls: string }> = {
  activo: { label: 'Activo', cls: cg.pillOk },
  seguimiento: { label: 'Seguimiento', cls: cg.pillWarn },
  riesgo: { label: 'En riesgo', cls: cg.pillRisk },
}
const fmtMoney = (n: number) => '$' + Math.round(n).toLocaleString('es-MX')
const fmtFecha = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso)
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })
}
const diasDesde = (iso: string | null) => iso ? Math.floor((Date.now() - new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).getTime()) / 86_400_000) : null
const waLink = (tel: string | null) => {
  const d = (tel || '').replace(/\D/g, '').slice(-10)
  return d.length === 10 ? `https://wa.me/52${d}` : null
}

export default function ClientesGrandesClient() {
  const [rows, setRows] = useState<Cliente[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tablaLista, setTablaLista] = useState(true)
  const [q, setQ] = useState('')
  const [owner, setOwner] = useState('Todos')
  const [salud, setSalud] = useState('Todas')
  const [orden, setOrden] = useState<'gasto' | 'ultimo' | 'accion'>('gasto')
  const [modal, setModal] = useState(false)
  const [editAccion, setEditAccion] = useState<Cliente | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/clientes-grandes', { cache: 'no-store' })
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'Error')
      setRows(j.clientes); setTablaLista(j.tablaLista); setError(null)
    } catch (e) { setError(String(e)) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const patch = async (c: Cliente, body: Record<string, unknown>) => {
    setRows(rs => rs.map(r => r.key === c.key ? { ...r, ...body } as Cliente : r))
    const r = await fetch(`/api/clientes-grandes/${encodeURIComponent(c.key)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!j.ok) { alert('No se pudo guardar: ' + (j.error || r.status)); load() }
  }
  const eliminar = async (c: Cliente) => {
    if (!confirm(`¿Quitar a ${c.empresa || c.email || 'este cliente'} de Clientes grandes?`)) return
    setRows(rs => rs.filter(r => r.key !== c.key))
    const r = await fetch(`/api/clientes-grandes/${encodeURIComponent(c.key)}`, { method: 'DELETE' })
    const j = await r.json().catch(() => ({}))
    if (!j.ok) { alert('No se pudo eliminar: ' + (j.error || r.status)); load() }
  }

  const filtered = useMemo(() => {
    const lq = q.trim().toLowerCase()
    let out = rows.filter(r =>
      (owner === 'Todos' || r.owner === owner) &&
      (salud === 'Todas' || r.salud === salud) &&
      (!lq || [r.empresa, r.email, r.contacto_nombre, r.telefono].some(v => (v || '').toLowerCase().includes(lq))))
    out = [...out].sort((a, b) => orden === 'gasto' ? b.total - a.total
      : orden === 'ultimo' ? (b.ultimo_pago || '').localeCompare(a.ultimo_pago || '')
      : (a.proxima_accion_fecha || '9999').localeCompare(b.proxima_accion_fecha || '9999'))
    return out
  }, [rows, q, owner, salud, orden])

  const kpi = useMemo(() => {
    const hoy = new Date(); const fin = new Date(); fin.setDate(hoy.getDate() + 7)
    return {
      n: rows.length,
      total: rows.reduce((s, r) => s + r.total, 0),
      riesgo: rows.filter(r => r.salud === 'riesgo').length,
      semana: rows.filter(r => r.proxima_accion_fecha && new Date(r.proxima_accion_fecha + 'T12:00:00') <= fin).length,
      sinOwner: rows.filter(r => r.owner === 'Sin asignar').length,
    }
  }, [rows])

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}><span className={styles.logoIcon}>⚡</span><span>Chambas CRM</span></div>
        <Sidebar active="clientes-grandes" />
      </aside>
      <main className={styles.main}>
        <header className={styles.topBar} style={{ justifyContent: 'space-between' }}>
          <div>
            <h1>💎 Clientes grandes</h1>
            <div className={cg.sub}>Cuentas con pagos de enero a hoy mayores a $5,000 · tu cartera para dar seguimiento y pedir reuniones</div>
          </div>
          <button className={cg.btnPrimary} onClick={() => setModal(true)} disabled={!tablaLista}
            title={tablaLista ? '' : 'Falta correr la migración clientes_grandes en Supabase'}>+ Agregar cliente</button>
        </header>
        <div className={styles.body}>
          {!tablaLista && <div className={cg.warn}>Falta crear la tabla <b>clientes_grandes</b> en Supabase (sql/migrations/2026-10-07-clientes-grandes.sql). Mientras tanto la lista se ve desde el sheet, pero no se puede editar owner, agregar ni eliminar.</div>}
          <div className={cg.kpis}>
            <Kpi label="Clientes grandes" value={String(kpi.n)} sub={`${kpi.sinOwner} sin owner`} color="var(--accent)" />
            <Kpi label="Ingreso acumulado" value={fmtMoney(kpi.total)} sub="Enero a hoy" color="var(--yellow)" />
            <Kpi label="En riesgo" value={String(kpi.riesgo)} sub="Sin pago en más de 60 días" color="var(--red)" />
            <Kpi label="Acciones esta semana" value={String(kpi.semana)} sub="Reuniones y seguimientos" color="var(--accent2)" />
          </div>
          <div className={cg.filters}>
            <input className={cg.search} placeholder="Buscar empresa, correo o contacto…" value={q} onChange={e => setQ(e.target.value)} />
            <select className={cg.select} value={owner} onChange={e => setOwner(e.target.value)}>
              <option value="Todos">Owner: Todos</option>{OWNERS.map(o => <option key={o} value={o}>Owner: {o}</option>)}
            </select>
            <select className={cg.select} value={salud} onChange={e => setSalud(e.target.value)}>
              <option value="Todas">Salud: Todas</option><option value="activo">Activo</option><option value="seguimiento">Seguimiento</option><option value="riesgo">En riesgo</option>
            </select>
            <select className={cg.select} value={orden} onChange={e => setOrden(e.target.value as typeof orden)}>
              <option value="gasto">Ordenar: Más gasto</option><option value="ultimo">Ordenar: Pago más reciente</option><option value="accion">Ordenar: Próxima acción</option>
            </select>
          </div>
          <div className={cg.tableWrap}>
            <table className={cg.table}>
              <thead><tr>
                <th>Empresa</th><th>Contacto</th><th>Owner</th><th className={cg.num}>Gasto total</th><th>Pagos</th><th>Último pago</th><th>Salud</th><th>Próxima acción</th><th></th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={9} className={cg.empty}>Cargando clientes del sheet…</td></tr>}
                {error && !loading && <tr><td colSpan={9} className={cg.empty}>Error: {error}</td></tr>}
                {!loading && !error && filtered.length === 0 && <tr><td colSpan={9} className={cg.empty}>Sin clientes con esos filtros</td></tr>}
                {!loading && filtered.map(c => {
                  const dias = diasDesde(c.ultimo_pago)
                  const wa = waLink(c.telefono)
                  return (
                    <tr key={c.key}>
                      <td>
                        <div className={cg.strong}>{c.empresa || c.email || '—'}{c.origen === 'manual' && <span className={cg.tag}>manual</span>}</div>
                        <div className={cg.muted}>{c.empresa ? c.email : ''}{c.lead_id && <> · <a href={`/leads/${c.lead_id}`} className={cg.link}>ver lead</a></>}</div>
                      </td>
                      <td>
                        <div>{c.contacto_nombre || '—'}</div>
                        <div className={cg.muted}>{c.contacto_puesto || c.telefono || ''}</div>
                      </td>
                      <td>
                        <select className={clsx(cg.ownerSel, c.owner === 'Sin asignar' && cg.ownerNone)} value={c.owner} disabled={!tablaLista}
                          onChange={e => patch(c, { owner: e.target.value })}>
                          {OWNERS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </td>
                      <td className={clsx(cg.num, cg.strong)}>{fmtMoney(c.total)}</td>
                      <td>{c.origen === 'manual' ? '—' : `${c.pagos} · ${c.vacantes} vac.`}</td>
                      <td>
                        <div>{fmtFecha(c.ultimo_pago)}</div>
                        {dias != null && <div className={cg.muted}>hace {dias} días</div>}
                      </td>
                      <td><span className={clsx(cg.pill, SALUD[c.salud].cls)}>{SALUD[c.salud].label}</span></td>
                      <td>
                        <button className={c.proxima_accion ? cg.btnGhost : cg.btnSmall} disabled={!tablaLista} onClick={() => setEditAccion(c)}>
                          {c.proxima_accion ? `${c.proxima_accion}${c.proxima_accion_fecha ? ' · ' + fmtFecha(c.proxima_accion_fecha) : ''}` : 'Pedir reunión'}
                        </button>
                      </td>
                      <td className={cg.actions}>
                        {wa && <a href={wa} target="_blank" rel="noreferrer" className={cg.iconBtn} title="WhatsApp">💬</a>}
                        {c.email && <a href={`mailto:${c.email}?subject=${encodeURIComponent('Reunión ChambasAI')}`} className={cg.iconBtn} title="Correo">✉️</a>}
                        <button className={cg.iconBtn} title="Quitar de la lista" disabled={!tablaLista} onClick={() => eliminar(c)}>🗑</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className={cg.muted}>Mostrando {filtered.length} de {rows.length} · Regla: entra todo cliente con pagos de enero a hoy mayores a $5,000 (sheet Revenue). Salud: activo ≤ 35 días desde su último pago, seguimiento ≤ 60, en riesgo &gt; 60.</div>
        </div>
      </main>
      {modal && <AgregarModal onClose={() => setModal(false)} onSaved={() => { setModal(false); load() }} />}
      {editAccion && <AccionModal c={editAccion} onClose={() => setEditAccion(null)}
        onSave={async b => { await patch(editAccion, b); setEditAccion(null) }} />}
    </div>
  )
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className={cg.kpi} style={{ borderLeftColor: color }}>
      <div className={cg.kpiLabel}>{label}</div><div className={cg.kpiValue}>{value}</div><div className={cg.muted}>{sub}</div>
    </div>
  )
}

function AccionModal({ c, onClose, onSave }: { c: Cliente; onClose: () => void; onSave: (b: Record<string, unknown>) => void }) {
  const [accion, setAccion] = useState(c.proxima_accion || 'Reunión')
  const [fecha, setFecha] = useState(c.proxima_accion_fecha || '')
  const [notas, setNotas] = useState(c.notas || '')
  return (
    <div className={cg.overlay} onClick={onClose}>
      <div className={cg.modal} onClick={e => e.stopPropagation()}>
        <h2>Próxima acción · {c.empresa || c.email}</h2>
        <label>Acción<input value={accion} onChange={e => setAccion(e.target.value)} placeholder="Reunión, QBR, propuesta, renovación…" /></label>
        <label>Fecha<input type="date" value={fecha} onChange={e => setFecha(e.target.value)} /></label>
        <label>Notas<textarea rows={3} value={notas} onChange={e => setNotas(e.target.value)} /></label>
        <div className={cg.modalBtns}>
          {c.proxima_accion && <button className={cg.btnGhost} onClick={() => onSave({ proxima_accion: null, proxima_accion_fecha: null, notas, ultimo_contacto: new Date().toISOString() })}>Marcar hecha</button>}
          <button className={cg.btnGhost} onClick={onClose}>Cancelar</button>
          <button className={cg.btnPrimary} onClick={() => onSave({ proxima_accion: accion, proxima_accion_fecha: fecha || null, notas })}>Guardar</button>
        </div>
      </div>
    </div>
  )
}

function AgregarModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ empresa: '', contacto_nombre: '', contacto_puesto: '', telefono: '', email: '', owner: 'Sin asignar', gasto: '', plan: '', proxima_accion: '', proxima_accion_fecha: '', notas: '' })
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF(s => ({ ...s, [k]: e.target.value }))
  const gasto = Number(f.gasto.replace(/[^0-9.]/g, '')) || 0
  const save = async () => {
    if (!f.empresa.trim()) { alert('Pon el nombre de la empresa'); return }
    setSaving(true)
    const r = await fetch('/api/clientes-grandes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) })
    const j = await r.json().catch(() => ({}))
    setSaving(false)
    if (!j.ok) { alert('No se pudo guardar: ' + (j.error || r.status)); return }
    onSaved()
  }
  return (
    <div className={cg.overlay} onClick={onClose}>
      <div className={cg.modal} onClick={e => e.stopPropagation()}>
        <h2>Agregar cliente grande</h2>
        <div className={cg.muted}>Clientes con pagos mayores a $5,000. Si el correo ya está en el sheet, se combinan.</div>
        <div className={cg.grid2}>
          <label className={cg.full}>Empresa *<input value={f.empresa} onChange={set('empresa')} /></label>
          <label>Contacto<input value={f.contacto_nombre} onChange={set('contacto_nombre')} /></label>
          <label>Puesto<input value={f.contacto_puesto} onChange={set('contacto_puesto')} /></label>
          <label>WhatsApp<input value={f.telefono} onChange={set('telefono')} /></label>
          <label>Correo<input value={f.email} onChange={set('email')} /></label>
          <label>Gasto acumulado (MXN)<input value={f.gasto} onChange={set('gasto')} placeholder="$" />
            {f.gasto && <span className={gasto > 5000 ? cg.ok : cg.bad}>{gasto > 5000 ? 'Cliente grande' : 'Menor a $5,000'}</span>}</label>
          <label>Owner<select value={f.owner} onChange={set('owner')}>{OWNERS.map(o => <option key={o}>{o}</option>)}</select></label>
          <label>Plan<input value={f.plan} onChange={set('plan')} placeholder="5 publicaciones · 30 días" /></label>
          <label>Próxima acción<input value={f.proxima_accion} onChange={set('proxima_accion')} placeholder="Kickoff, reunión…" /></label>
          <label>Fecha<input type="date" value={f.proxima_accion_fecha} onChange={set('proxima_accion_fecha')} /></label>
          <label className={cg.full}>Notas<textarea rows={2} value={f.notas} onChange={set('notas')} /></label>
        </div>
        <div className={cg.modalBtns}>
          <button className={cg.btnGhost} onClick={onClose}>Cancelar</button>
          <button className={cg.btnPrimary} onClick={save} disabled={saving}>{saving ? 'Guardando…' : 'Guardar cliente'}</button>
        </div>
      </div>
    </div>
  )
}
