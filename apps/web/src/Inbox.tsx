import producto from './config/producto.json'
import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, claveDeCache } from './api'
import { useToast } from './Toast'
import type { AuthUser, LeadListItem } from '@shared/types'
import { ETIQUETAS_VALIDAS } from '@shared/labels'
import { STAGE_LABELS, STAGE_ORDER, stageLabel } from '@shared/stages'
import { loadSeen, saveSeen, isUnread } from './unread'
import Conversation from './Conversation'
import AgentPlayground from './AgentPlayground'
import Metricas from './Metricas'

type View = 'inbox' | 'flujos' | 'metricas'

const TAMANO_PAGINA = 25

export default function Inbox({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [view, setView] = useState<View>('inbox')
  const [selId, setSelId] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [stage, setStage] = useState('')
  const [label, setLabel] = useState('')   // '' = todas · '__none__' = sin etiqueta
  const [offset, setOffset] = useState(0)
  const [seen, setSeen] = useState(() => loadSeen(user.id))
  const toast = useToast()
  const scope = claveDeCache(user)

  // Búsqueda y filtro van al SERVIDOR (Hito B2). Antes se filtraba en el navegador lo que ya
  // estaba en memoria: con más leads que el límite de página, el lead buscado podía estar
  // fuera de lo cargado y la pantalla decía "ningún lead coincide" — falso. Aquí el backend
  // filtra sobre toda la bandeja y devuelve `total`, y la lista es una página real con
  // "cargar más", no una lista parcial presentada como completa.
  // Un pequeño debounce evita una consulta por pulsación de teclado.
  const [qAplicado, setQAplicado] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQAplicado(q), 300)
    return () => clearTimeout(t)
  }, [q])

  const filtrando = !!(qAplicado.trim() || stage || label)
  // Al cambiar un filtro se vuelve a la primera página: pedir la 3 con otro filtro Mezclaría
  // páginas de dos búsquedas distintas.
  useEffect(() => { setOffset(0) }, [qAplicado, stage, label])

  const leadsQ = useQuery({
    queryKey: scope.concat('leads', qAplicado, stage, label, offset),
    queryFn: () => api.leadsPage({ limit: TAMANO_PAGINA, offset, q: qAplicado, stage, label }),
    refetchInterval: 10_000,
    placeholderData: p => p,   // evita el parpadeo al cambiar de página/filtro
  })

  const page = leadsQ.data?.page
  const all = leadsQ.data?.items ?? []
  const total = page?.total ?? 0
  // Lo NO leído se cuenta sobre lo que está cargado, y se rotula como tal: no se presenta
  // como el total de la bandeja, porque no lo es.
  const noLeidosCargados = useMemo(() => all.filter(l => isUnread(l, seen)).length, [all, seen])
  const noLeidos = noLeidosCargados

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

  // Aviso en la pestaña del navegador aunque no esté enfocada.
  useEffect(() => {
    document.title = noLeidos > 0 ? `(${noLeidos}) ${producto.inbox}` : producto.inbox
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

  // Al cambiar el filtro, el lead abierto puede quedar fuera de la página actual: se cierra
  // para no dejar una conversación abierta que la lista ya no muestra.
  useEffect(() => {
    if (selId == null || all.length === 0) return
    if (!all.some(l => l.id === selId)) setSelId(null)
  }, [all, selId])

  const cargadoHasta = all.length + offset
  const siguiente = offset + TAMANO_PAGINA

  return (
    <div className={`app${view === 'flujos' ? ' app-flow' : ''}`}>
      <nav className="rail">
        <div className="rail-logo">H</div>
        <button className={`rb${view === 'inbox' ? ' on' : ''}`} title="Inbox" onClick={() => setView('inbox')}>
          💬<span>INBOX</span>
          {noLeidos > 0 && <span className="rb-badge">{noLeidos > 99 ? '99+' : noLeidos}</span>}
        </button>
        <button className={`rb${view === 'flujos' ? ' on' : ''}`} title="Configuración de campañas" onClick={() => setView('flujos')}>⚡<span>CAMPANAS</span></button>
        <button className={`rb${view === 'metricas' ? ' on' : ''}`} title="Actividad y resultado" onClick={() => setView('metricas')}>📊<span>MÉTRICAS</span></button>
        <div className="rail-sp" />
        <button className="rail-av" title={`${user.nombre} — cerrar sesión`} onClick={onLogout}>
          {user.initials}
        </button>
      </nav>

      {view === 'flujos' ? <AgentPlayground user={user} /> : view === 'metricas' ? <Metricas user={user} /> : <>
      <aside className="sidebar">
        <div className="sb-top">
          <div className="sb-title">Inbox</div>
          <div className="sb-sub">
            {user.nombre} · {user.role === 'ADMIN' ? 'todos los leads' : 'mis leads'}
            {/* El número es el TOTAL del filtro (servidor), no el de la página: sin esto la
                pantalla insinúa que solo hay 25 leads cuando hay 400. */}
            {!leadsQ.isLoading && <> · {filtrando ? `${total} coinciden` : `${total} leads`}</>}
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
          {filtrando && (
            <button className="btn sb-clear" onClick={() => { setQ(''); setStage(''); setLabel('') }}>
              Quitar filtros
            </button>
          )}
        </div>
        <div className="lead-list">
          {leadsQ.isLoading && <div className="empty">Cargando…</div>}
          {leadsQ.isError && (
            <div className="empty">
              No se pudo cargar la bandeja. <button className="btn" onClick={() => void leadsQ.refetch()}>Reintentar</button>
            </div>
          )}
          {!leadsQ.isLoading && !leadsQ.isError && all.length === 0 && (
            <div className="empty">{filtrando ? 'Ningún lead coincide con el filtro' : 'Sin leads todavía'}</div>
          )}
          {all.map(l => (
            <LeadRow key={l.id} lead={l} active={l.id === selId} unread={isUnread(l, seen)} onClick={() => setSelId(l.id)} />
          ))}
          {/* Paginación explícita: si hay más, se dice y se ofrece. Una lista parcial no se
              presenta como si fuera todo. */}
          {page?.hasMore && (
            <button className="btn sb-more" disabled={leadsQ.isFetching} onClick={() => setOffset(siguiente)}>
              {leadsQ.isFetching ? 'Cargando…' : `Cargar más (${cargadoHasta} de ${total})`}
            </button>
          )}
          {!page?.hasMore && total > 0 && (
            <div className="empty small">{cargadoHasta} de {total} leads</div>
          )}
        </div>
      </aside>

      <main className="main">
        {selId
          ? <Conversation key={selId} leadId={selId} user={user} />
          : <div className="placeholder">Selecciona un lead para ver la conversación</div>}
      </main>
      </>}
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
        {/* La etapa es lo que INFIERE el bot; el resultado es lo que confirmó una persona.
            Se muestran por separado y con etiquetas distintas para que nadie los confunda
            (ni confunda el embudo con las ventas). */}
        <span className="stage" title="Etapa que el bot infiere de la conversación">{stageLabel(lead.stage)}</span>
        {lead.resultadoEtiqueta
          ? <span className="pill pill-resultado" title="Resultado confirmado por un vendedor">{lead.resultadoEtiqueta}</span>
          : <span className="pill pill-sindato" title="Sin resultado registrado por un humano">resultado: no disponible</span>}
        {lead.objecion && <span className="obj">obj: {lead.objecion}</span>}
        {lead.producto && <span className="prod">{lead.producto}</span>}
      </div>
    </button>
  )
}