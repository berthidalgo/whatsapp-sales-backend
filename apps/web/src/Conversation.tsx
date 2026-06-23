import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import type { ConversationEvent } from '@shared/types'

export default function Conversation({ leadId }: { leadId: number }) {
  const qc = useQueryClient()
  const detailQ = useQuery({ queryKey: ['lead', leadId], queryFn: () => api.leadDetail(leadId) })
  const convQ = useQuery({ queryKey: ['conv', leadId], queryFn: () => api.conversation(leadId), refetchInterval: 10_000 })
  const d = detailQ.data

  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [cambiandoModo, setCambiandoModo] = useState(false)

  function refrescar() {
    qc.invalidateQueries({ queryKey: ['conv', leadId] })
    qc.invalidateQueries({ queryKey: ['lead', leadId] })
    qc.invalidateQueries({ queryKey: ['leads'] })
  }

  async function enviar() {
    const t = texto.trim()
    if (!t || enviando) return
    setEnviando(true)
    try {
      await api.reply(leadId, t)   // responder TOMA el control (el bot se calla)
      setTexto('')
      refrescar()
    } catch { /* TODO: toast de error en un hito futuro */ }
    finally { setEnviando(false) }
  }

  async function toggleModo() {
    if (!d || cambiandoModo) return
    const nuevo = d.mode === 'HUMAN_ACTIVE' ? 'AUTO_CONSULTIVO' : 'HUMAN_ACTIVE'
    setCambiandoModo(true)
    try { await api.setMode(leadId, nuevo); refrescar() }
    catch { /* TODO: toast */ }
    finally { setCambiandoModo(false) }
  }

  const humano = d?.mode === 'HUMAN_ACTIVE'

  return (
    <div className="conv">
      <header className="conv-header">
        <div>
          <div className="conv-name">{d?.nombre ?? '…'}</div>
          <div className="conv-meta">
            {d && (
              <>
                <span className="stage">{d.stage}</span>
                <span className={`pill ${humano ? 'pill-human' : 'pill-bot'}`}>
                  {humano ? '👤 humano' : '🤖 bot'}
                </span>
                {d.esRecurrente && <span className="pill">↩ vuelve</span>}
              </>
            )}
          </div>
        </div>
        <div className="conv-actions">
          {d?.cierreResumen && <div className="cierre" title="Estado del closer">{d.cierreResumen}</div>}
          {d && (
            <button className="btn" onClick={() => void toggleModo()} disabled={cambiandoModo}>
              {humano ? '🤖 Devolver al bot' : '✋ Tomar control'}
            </button>
          )}
        </div>
      </header>

      <div className="msgs">
        {convQ.isLoading && <div className="empty">Cargando conversación…</div>}
        {convQ.data?.eventos.map((e, i) => <EventItem key={i} ev={e} />)}
      </div>

      <div className="conv-input">
        <input
          value={texto}
          onChange={e => setTexto(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void enviar() }}
          placeholder={humano ? 'Escribe tu respuesta…' : 'Escribe para responder (tomarás el control del chat)…'}
          disabled={enviando}
        />
        <button className="btn btn-send" onClick={() => void enviar()} disabled={enviando || !texto.trim()}>
          {enviando ? '…' : 'Enviar'}
        </button>
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
