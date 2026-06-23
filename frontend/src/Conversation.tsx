import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { ConversationEvent } from '@shared/types'

export default function Conversation({ leadId }: { leadId: number }) {
  const detailQ = useQuery({ queryKey: ['lead', leadId], queryFn: () => api.leadDetail(leadId) })
  const convQ = useQuery({ queryKey: ['conv', leadId], queryFn: () => api.conversation(leadId), refetchInterval: 10_000 })
  const d = detailQ.data

  return (
    <div className="conv">
      <header className="conv-header">
        <div>
          <div className="conv-name">{d?.nombre ?? '…'}</div>
          <div className="conv-meta">
            {d && (
              <>
                <span className="stage">{d.stage}</span>
                <span className={`pill ${d.mode === 'HUMAN_ACTIVE' ? 'pill-human' : 'pill-bot'}`}>
                  {d.mode === 'HUMAN_ACTIVE' ? '👤 humano' : '🤖 bot'}
                </span>
                {d.esRecurrente && <span className="pill">↩ vuelve</span>}
              </>
            )}
          </div>
        </div>
        {d?.cierreResumen && <div className="cierre" title="Estado del closer">{d.cierreResumen}</div>}
      </header>

      <div className="msgs">
        {convQ.isLoading && <div className="empty">Cargando conversación…</div>}
        {convQ.data?.eventos.map((e, i) => <EventItem key={i} ev={e} />)}
      </div>

      <div className="conv-input">
        <input disabled placeholder="Responder se habilita en el próximo hito…" />
      </div>
    </div>
  )
}

function EventItem({ ev }: { ev: ConversationEvent }) {
  if (ev.kind === 'state') {
    return <div className="state-pill">⦿ {ev.label} · {fmt(ev.at)}</div>
  }
  const cls = ev.origen === 'LEAD' ? 'in' : ev.origen === 'VENDEDOR' ? 'vendor' : 'bot'
  return (
    <div className={`bubble-row ${cls}`}>
      <div className={`bubble ${cls}`}>
        {ev.origen !== 'LEAD' && <div className="bub-tag">{ev.origen}</div>}
        <div className="bub-text">{ev.texto}</div>
        <div className="bub-time">{fmt(ev.at)}</div>
      </div>
    </div>
  )
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}
