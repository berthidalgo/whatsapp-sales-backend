import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { AuthUser, LeadListItem } from '@shared/types'
import Conversation from './Conversation'

export default function Inbox({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [selId, setSelId] = useState<number | null>(null)
  const leadsQ = useQuery({ queryKey: ['leads'], queryFn: api.leads, refetchInterval: 10_000 })

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-logo">H</div>
        <button className="rb on" title="Inbox">💬<span>INBOX</span></button>
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
          <div className="sb-sub">{user.nombre} · {user.role === 'ADMIN' ? 'todos los leads' : 'mis leads'}</div>
        </div>
        <div className="lead-list">
          {leadsQ.isLoading && <div className="empty">Cargando…</div>}
          {leadsQ.isError && <div className="empty">Error al cargar leads</div>}
          {leadsQ.data?.length === 0 && <div className="empty">Sin leads todavía</div>}
          {leadsQ.data?.map(l => (
            <LeadRow key={l.id} lead={l} active={l.id === selId} onClick={() => setSelId(l.id)} />
          ))}
        </div>
      </aside>

      <main className="main">
        {selId
          ? <Conversation leadId={selId} />
          : <div className="placeholder">Selecciona un lead para ver la conversación</div>}
      </main>
    </div>
  )
}

function LeadRow({ lead, active, onClick }: { lead: LeadListItem; active: boolean; onClick: () => void }) {
  const esHumano = lead.mode === 'HUMAN_ACTIVE'
  return (
    <button className={`lead-row${active ? ' active' : ''}`} onClick={onClick}>
      <div className="lr-1">
        <span className="lr-name">{lead.nombre}</span>
        <span className={`pill ${esHumano ? 'pill-human' : 'pill-bot'}`}>{esHumano ? '👤 humano' : '🤖 bot'}</span>
      </div>
      <div className="lr-2">{lead.ultimoMensaje || '—'}</div>
      <div className="lr-3">
        <span className="stage">{lead.stage}</span>
        {lead.objecion && <span className="obj">obj: {lead.objecion}</span>}
        {lead.producto && <span className="prod">{lead.producto}</span>}
      </div>
    </button>
  )
}
