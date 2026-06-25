import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { useToast } from './Toast'
import type { AuthUser, LeadListItem } from '@shared/types'
import { ETIQUETAS_VALIDAS } from '@shared/labels'
import { STAGE_LABELS, STAGE_ORDER, stageLabel } from '@shared/stages'
import { loadSeen, saveSeen, isUnread } from './unread'
import Conversation from './Conversation'

export default function Inbox({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [selId, setSelId] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [stage, setStage] = useState('')
  const [label, setLabel] = useState('')   // '' = todas · '__none__' = sin etiqueta
  const [seen, setSeen] = useState(() => loadSeen(user.id))
  const toast = useToast()
  const leadsQ = useQuery({ queryKey: ['leads'], queryFn: api.leads, refetchInterval: 10_000 })

  const all = leadsQ.data ?? []

  // Marca un lead como visto (persiste su último mensaje). Functional update para no
  // depender del `seen` del closure; no-op si ya estaba al día (evita re-render).
  const markSeen = useCallback((lead: LeadListItem) => {
    if (!lead.ultimoMensajeAt) return
    setSeen(prev => {
      if (prev[lead.id] === lead.ultimoMensajeAt) return prev
      const next = { ...prev, [lead.id]: lead.ultimoMensajeAt! }
      saveSeen(user.id, next)
      return next
    })
  }, [user.id])

  // El lead ABIERTO siempre cuenta como leído — al abrirlo y cuando llega un mensaje
  // nuevo mientras está abierto (el poll actualiza `all` → este efecto re-marca).
  useEffect(() => {
    if (selId == null) return
    const lead = all.find(l => l.id === selId)
    if (lead) markSeen(lead)
  }, [selId, all, markSeen])

  const noLeidos = useMemo(() => all.filter(l => isUnread(l, seen)).length, [all, seen])

  // Aviso en la pestaña del navegador aunque no esté enfocada.
  useEffect(() => {
    document.title = noLeidos > 0 ? `(${noLeidos}) Hidata Inbox` : 'Hidata Inbox'
  }, [noLeidos])

  // Notificación in-app: toast cuando un lead PASA a no-leído entre polls (= el lead
  // escribió algo nuevo). `seen` vía ref para no re-disparar al marcar visto. Edge cases:
  //  - carga inicial: el primer set es BASELINE, no avisa (no son "nuevos").
  //  - lead abierto (selId): no se avisa, lo estás viendo.
  //  - ya estaba no-leído: no re-avisa (solo la transición no-leído→leído→no-leído).
  const seenRef = useRef(seen)
  seenRef.current = seen
  const prevUnreadRef = useRef<Set<number> | null>(null)
  useEffect(() => {
    if (leadsQ.isLoading) return                       // aún sin datos
    const current = new Set(all.filter(l => isUnread(l, seenRef.current)).map(l => l.id))
    const prev = prevUnreadRef.current
    prevUnreadRef.current = current
    if (prev === null) return                          // primer set con datos = baseline
    const nuevos = all.filter(l => l.id !== selId && current.has(l.id) && !prev.has(l.id))
    if (nuevos.length === 1) toast(`💬 Nuevo mensaje de ${nuevos[0].nombre}`, 'info')
    else if (nuevos.length > 1) toast(`💬 ${nuevos.length} leads con mensajes nuevos`, 'info')
  }, [all, selId, leadsQ.isLoading, toast])
  // Filtrado client-side sobre la lista cargada (≤200). useMemo: no re-filtra en cada
  // render, solo cuando cambian los datos o el filtro.
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return all.filter(l => {
      if (ql && !`${l.nombre} ${l.telefono} ${l.producto ?? ''}`.toLowerCase().includes(ql)) return false
      if (stage && l.stage !== stage) return false
      if (label === '__none__') { if (l.label) return false }
      else if (label && l.label !== label) return false
      return true
    })
  }, [all, q, stage, label])

  const filtrando = !!(q.trim() || stage || label)

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-logo">H</div>
        <button className="rb on" title="Inbox">
          💬<span>INBOX</span>
          {noLeidos > 0 && <span className="rb-badge">{noLeidos > 99 ? '99+' : noLeidos}</span>}
        </button>
        <button className="rb" disabled title="Próximo hito">⚡<span>FLUJOS</span></button>
        <button className="rb" disabled title="Próximo hito">🧠<span>BRAIN</span></button>
        <div className="rail-sp" />
        <button className="rail-av" title={`${user.nombre} — cerrar sesión`} onClick={onLogout}>
          {user.initials}
        </button>
      </nav>

      <aside className="sidebar">
        <div className="sb-top">
          <div className="sb-title">Inbox</div>
          <div className="sb-sub">
            {user.nombre} · {user.role === 'ADMIN' ? 'todos los leads' : 'mis leads'}
            {!leadsQ.isLoading && <> · {filtrando ? `${filtered.length} de ${all.length}` : `${all.length}`}</>}
          </div>
          <input
            className="sb-search"
            placeholder="Buscar nombre, teléfono o producto…"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          <div className="sb-filters">
            <select value={stage} onChange={e => setStage(e.target.value)} title="Filtrar por etapa">
              <option value="">Toda etapa</option>
              {STAGE_ORDER.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>
            <select value={label} onChange={e => setLabel(e.target.value)} title="Filtrar por etiqueta">
              <option value="">Toda etiqueta</option>
              <option value="__none__">Sin etiqueta</option>
              {ETIQUETAS_VALIDAS.map(et => <option key={et} value={et}>{et}</option>)}
            </select>
          </div>
        </div>
        <div className="lead-list">
          {leadsQ.isLoading && <div className="empty">Cargando…</div>}
          {leadsQ.isError && <div className="empty">Error al cargar leads</div>}
          {!leadsQ.isLoading && all.length === 0 && <div className="empty">Sin leads todavía</div>}
          {!leadsQ.isLoading && all.length > 0 && filtered.length === 0 && (
            <div className="empty">Ningún lead coincide con el filtro</div>
          )}
          {filtered.map(l => (
            <LeadRow key={l.id} lead={l} active={l.id === selId} unread={isUnread(l, seen)} onClick={() => setSelId(l.id)} />
          ))}
        </div>
      </aside>

      <main className="main">
        {selId
          ? <Conversation leadId={selId} user={user} />
          : <div className="placeholder">Selecciona un lead para ver la conversación</div>}
      </main>
    </div>
  )
}

function LeadRow({ lead, active, unread, onClick }: { lead: LeadListItem; active: boolean; unread: boolean; onClick: () => void }) {
  const esHumano = lead.mode === 'HUMAN_ACTIVE'
  return (
    <button className={`lead-row${active ? ' active' : ''}${unread ? ' unread' : ''}`} onClick={onClick}>
      <div className="lr-1">
        <span className="lr-name-wrap">
          {unread && <span className="unread-dot" title="Mensaje nuevo del lead" />}
          <span className="lr-name">{lead.nombre}</span>
          {lead.label && <span className="pill pill-label">🏷 {lead.label}</span>}
        </span>
        <span className={`pill ${esHumano ? 'pill-human' : 'pill-bot'}`}>{esHumano ? '👤 humano' : '🤖 bot'}</span>
      </div>
      <div className="lr-2">{lead.ultimoMensaje || '—'}</div>
      <div className="lr-3">
        <span className="stage">{stageLabel(lead.stage)}</span>
        {lead.objecion && <span className="obj">obj: {lead.objecion}</span>}
        {lead.producto && <span className="prod">{lead.producto}</span>}
      </div>
    </button>
  )
}
