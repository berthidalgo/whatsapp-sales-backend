import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { useToast } from './Toast'
import type { AuthUser, ConversationEvent, MediaRef } from '@shared/types'
import { ETIQUETAS_VALIDAS } from '@shared/labels'
import { stageLabel } from '@shared/stages'

export default function Conversation({ leadId, user }: { leadId: number; user: AuthUser }) {
  const qc = useQueryClient()
  const toast = useToast()
  const detailQ = useQuery({ queryKey: ['lead', leadId], queryFn: () => api.leadDetail(leadId) })
  const convQ = useQuery({ queryKey: ['conv', leadId], queryFn: () => api.conversation(leadId), refetchInterval: 10_000 })
  const d = detailQ.data

  const puedeReasignar = user.role === 'ADMIN' || user.role === 'SUPERVISOR'
  // Picker de reasignar: vendedores del MISMO tenant (endpoint scopeado, no el público).
  const vendorsQ = useQuery({ queryKey: ['vendors-scoped'], queryFn: api.vendorsScoped, enabled: puedeReasignar })

  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [cambiandoModo, setCambiandoModo] = useState(false)
  const [reasignando, setReasignando] = useState(false)
  const [etiquetando, setEtiquetando] = useState(false)

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
      setTexto('')                 // solo se limpia si NO lanzó → en error el texto se conserva
      refrescar()
    } catch { toast('No se pudo enviar el mensaje. Tu texto sigue acá, reintenta.') }
    finally { setEnviando(false) }
  }

  async function toggleModo() {
    if (!d || cambiandoModo) return
    const nuevo = d.mode === 'HUMAN_ACTIVE' ? 'AUTO_CONSULTIVO' : 'HUMAN_ACTIVE'
    setCambiandoModo(true)
    try { await api.setMode(leadId, nuevo); refrescar() }
    catch { toast('No se pudo cambiar el control del chat.') }
    finally { setCambiandoModo(false) }
  }

  async function reasignar(vendorId: number) {
    if (!vendorId || reasignando) return
    setReasignando(true)
    try {
      await api.assign(leadId, vendorId)
      const dest = vendorsQ.data?.find(v => v.id === vendorId)
      toast(`Lead reasignado${dest ? ` a ${dest.nombre}` : ''}.`, 'success')
      refrescar()
    } catch { toast('No se pudo reasignar el lead.') }
    finally { setReasignando(false) }
  }

  async function etiquetar(label: string | null) {
    if (etiquetando) return
    setEtiquetando(true)
    try { await api.setLabel(leadId, label); refrescar() }
    catch { toast('No se pudo guardar la etiqueta.') }
    finally { setEtiquetando(false) }
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
                <span className="stage">{stageLabel(d.stage)}</span>
                <span className={`pill ${humano ? 'pill-human' : 'pill-bot'}`}>
                  {humano ? '👤 humano' : '🤖 bot'}
                </span>
                {d.esRecurrente && <span className="pill">↩ vuelve</span>}
                {d.label && <span className="pill pill-label">🏷 {d.label}</span>}
              </>
            )}
          </div>
        </div>
        <div className="conv-actions">
          {d?.cierreResumen && <div className="cierre" title="Estado del closer">{d.cierreResumen}</div>}
          {d && (
            <select
              className="btn label-select"
              value={d.label ?? ''}
              disabled={etiquetando}
              onChange={e => void etiquetar(e.target.value || null)}
              title="Etiquetar lead"
            >
              <option value="">🏷 Sin etiqueta</option>
              {ETIQUETAS_VALIDAS.map(et => <option key={et} value={et}>{et}</option>)}
            </select>
          )}
          {puedeReasignar && (
            <select
              className="btn reassign-select"
              value=""
              disabled={reasignando}
              onChange={e => { const v = Number(e.target.value); if (v) void reasignar(v) }}
              title="Reasignar a otro vendedor"
            >
              <option value="">↗ Reasignar a…</option>
              {vendorsQ.data?.map(v => <option key={v.id} value={v.id}>{v.nombre}</option>)}
            </select>
          )}
          {d && (
            <button className="btn" onClick={() => void toggleModo()} disabled={cambiandoModo}>
              {humano ? '🤖 Devolver al bot' : '✋ Tomar control'}
            </button>
          )}
        </div>
      </header>

      <div className="msgs">
        {convQ.isLoading && <div className="empty">Cargando conversación…</div>}
        {convQ.isError && <div className="empty">No se pudo cargar la conversación. Reintentando…</div>}
        {convQ.data?.eventos.map((e, i) => <EventItem key={i} ev={e} leadId={leadId} />)}
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

// Marcador de media que persiste el webhook ("[📷 …]" / "[🎙️ …]"): si la imagen ya
// se renderiza, el texto es redundante → lo ocultamos (pero conservamos captions reales).
function esMarcadorMedia(t: string): boolean {
  return /^\[(📷|🎙️)/.test(t)
}

function EventItem({ ev, leadId }: { ev: ConversationEvent; leadId: number }) {
  if (ev.kind === 'state') {
    return <div className="state-pill">⦿ {ev.label} · {fmt(ev.at)}</div>
  }
  const cls = ev.origen === 'LEAD' ? 'in' : ev.origen === 'VENDEDOR' ? 'vendor' : 'bot'
  const hayImagen = ev.media?.tipo === 'image'
  const mostrarTexto = ev.texto && !(hayImagen && esMarcadorMedia(ev.texto))
  return (
    <div className={`bubble-row ${cls}`}>
      <div className={`bubble ${cls}`}>
        {ev.origen !== 'LEAD' && <div className="bub-tag">{ev.origen}</div>}
        {hayImagen && <MediaImage leadId={leadId} media={ev.media as MediaRef} />}
        {mostrarTexto && <div className="bub-text">{ev.texto}</div>}
        <div className="bub-time">{fmt(ev.at)}</div>
      </div>
    </div>
  )
}

// Baja la imagen con auth (object URL) y la revoca al desmontar (evita fugas de memoria).
function MediaImage({ leadId, media }: { leadId: number; media: MediaRef }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let url: string | null = null
    let vivo = true
    api.mediaObjectUrl(leadId, media.id)
      .then(u => { url = u; if (vivo) setSrc(u); else URL.revokeObjectURL(u) })
      .catch(() => { if (vivo) setError(true) })
    return () => { vivo = false; if (url) URL.revokeObjectURL(url) }
  }, [leadId, media.id])
  if (error) return <div className="media-error">no se pudo cargar la imagen</div>
  if (!src) return <div className="media-loading">cargando imagen…</div>
  return <img className="media-img" src={src} alt="adjunto del lead" />
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}
