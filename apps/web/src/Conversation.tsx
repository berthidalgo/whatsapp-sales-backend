import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, claveDeCache } from './api'
import { useToast } from './Toast'
import type { AuthUser, ConversationEvent, ConversationResponse, MediaRef } from '@shared/types'
import { ETIQUETAS_VALIDAS } from '@shared/labels'
import { stageLabel } from '@shared/stages'
import LeadDebrief from './LeadDebrief'
import { conversationEventId, mergeEarlierConversation, mergeLatestConversation } from './conversation-history'
import { guardarBorrador, leerBorrador } from './drafts'

export default function Conversation({ leadId, user }: { leadId: number; user: AuthUser }) {
  const qc = useQueryClient()
  const toast = useToast()
  // Las claves llevan el ámbito de sesión (tenant + usuario): dos sesiones nunca comparten
  // caché aunque el mismo lead exista en dos empresas.
  const scope = claveDeCache(user)
  const detailQ = useQuery({ queryKey: scope.concat('lead', leadId), queryFn: () => api.leadDetail(leadId) })
  const convKey = scope.concat('conv', leadId)
  const convQ = useQuery({
    queryKey: convKey,
    queryFn: async () => {
      const latest = await api.conversation(leadId, 300)
      return mergeLatestConversation(qc.getQueryData<ConversationResponse>(convKey), latest)
    },
    refetchInterval: 10_000,
  })
  const d = detailQ.data
  const msgsRef = useRef<HTMLDivElement>(null)
  const selectedLeadRef = useRef(leadId)
  selectedLeadRef.current = leadId
  const scrollAnchorRef = useRef<{ leadId: number; id: string; offset: number } | null>(null)
  const [loadingEarlierLead, setLoadingEarlierLead] = useState<number | null>(null)

  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current
    const container = msgsRef.current
    if (!anchor || !container) return
    scrollAnchorRef.current = null
    if (anchor.leadId !== leadId) return
    const element = Array.from(container.children).find(child => child.getAttribute('data-event-id') === anchor.id)
    if (element) container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
  }, [convQ.data?.eventos, leadId])

  async function cargarAnterior() {
    const page = qc.getQueryData<ConversationResponse>(convKey)?.page
    if (loadingEarlierLead === leadId || !page?.hayMas || !page.cursor) return
    setLoadingEarlierLead(leadId)
    try {
      const earlier = await api.conversation(leadId, page.limit, page.cursor)
      const container = msgsRef.current
      if (container && selectedLeadRef.current === leadId) {
        const top = container.getBoundingClientRect().top
        const visible = Array.from(container.children).find(child => child.hasAttribute('data-event-id') && child.getBoundingClientRect().bottom > top)
        if (visible) scrollAnchorRef.current = { leadId, id: visible.getAttribute('data-event-id')!, offset: visible.getBoundingClientRect().top - top }
      }
      qc.setQueryData<ConversationResponse>(convKey, current => mergeEarlierConversation(current, earlier))
    } catch {
      if (selectedLeadRef.current === leadId) toast('No se pudieron cargar los mensajes anteriores. Reintenta.')
    } finally {
      setLoadingEarlierLead(current => current === leadId ? null : current)
    }
  }

  const puedeReasignar = user.role === 'ADMIN' || user.role === 'SUPERVISOR'
  // Picker de reasignar: vendedores del MISMO tenant (endpoint scopeado, no el público).
  const vendorsQ = useQuery({ queryKey: scope.concat('vendors-scoped'), queryFn: api.vendorsScoped, enabled: puedeReasignar })

  // ═══ BORRADOR POR LEAD (Hito B1) ═══
  // El texto se carga y se guarda PARA el lead abierto. Cambiar de conversación restaura el
  // borrador de la nueva y NO arrastra el de la anterior. Es lo que evita enviar el texto de
  // Ana a Bruno (un envío erróneo a un cliente real, no reversible).
  const [texto, setTexto] = useState(() => leerBorrador(leadId))
  useEffect(() => {
    setTexto(leerBorrador(leadId))
  }, [leadId])
  const onTexto = useCallback((valor: string) => {
    setTexto(valor)
    guardarBorrador(selectedLeadRef.current, valor)
  }, [])

  // El envío en curso se amarra al lead con el que arrancó. Si el usuario cambia de
  // conversación mientras espera, el mensaje sigue yendo a SU lead, y la respuesta se
  // descarta si ya no estamos viendo esa conversación (no se pinta en otro lado).
  const envioRef = useRef<{ leadId: number; texto: string } | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [cambiandoModo, setCambiandoModo] = useState(false)
  const [reasignando, setReasignando] = useState(false)
  const [etiquetando, setEtiquetando] = useState(false)
  const [debriefOpen, setDebriefOpen] = useState(false)
  // Ventana de 24 h de Meta: cuando se cierra, el backend dice con qué plantilla se
  // reabre. Se guarda acá para ofrecerlo en vez de dejar al vendedor con un error seco.
  const [ventanaCerrada, setVentanaCerrada] = useState<{ plantilla: string | null } | null>(null)
  const [reabriendo, setReabriendo] = useState(false)

  function refrescar() {
    qc.invalidateQueries({ queryKey: scope.concat('conv', leadId) })
    qc.invalidateQueries({ queryKey: scope.concat('lead', leadId) })
    qc.invalidateQueries({ queryKey: scope.concat('leads') })
  }

  async function enviar() {
    const t = texto.trim()
    if (!t || enviando) return
    // Se congela el destino AHORA: aunque el usuario cambie de lead mientras espera, el
    // mensaje va a este. Un envío a un cliente equivocado es irreversible.
    const destino = leadId
    envioRef.current = { leadId: destino, texto: t }
    setEnviando(true)
    try {
      await api.reply(destino, t)   // responder TOMA el control (el bot se calla)
      // Solo se borra el borrador si sigue siendo el del lead que se envió Y no se escribió
      // otra cosa mientras tanto (si el usuario siguió escribiendo, no se pierde nada).
      if (envioRef.current?.texto === t && selectedLeadRef.current === destino) {
        onTexto('')
        guardarBorrador(destino, '')
        setVentanaCerrada(null)
      }
      refrescar()
    } catch (e) {
      // 409 con ventanaCerrada no es un fallo del vendedor: el chat lleva más de 24 h
      // callado y Meta solo lo reabre con una plantilla. Se le ofrece, no se le regaña.
      if (e instanceof ApiError && e.status === 409 && e.body?.ventanaCerrada) {
        setVentanaCerrada({ plantilla: e.body.plantilla ?? null })
      } else if (selectedLeadRef.current === destino) {
        toast('No se pudo enviar el mensaje. Tu texto sigue acá, reintenta.')
      }
    }
    finally { envioRef.current = null; setEnviando(false) }
  }

  async function reabrir() {
    if (reabriendo) return
    const destino = leadId
    setReabriendo(true)
    try {
      const r = await api.reabrir(destino)
      setVentanaCerrada(null)
      // Enviar una plantilla NO abre la ventana de texto libre: se espera la respuesta del
      // cliente. El texto pendiente se conserva (puede ir después, cuando conteste).
      toast(`Plantilla "${r.plantilla}" enviada. Cuando el cliente responda vas a poder escribirle normal.`)
      refrescar()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'No se pudo enviar la plantilla.')
    }
    finally { setReabriendo(false) }
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
                <span className="stage" title="Etapa que el bot infiere de la conversación">{stageLabel(d.stage)}</span>
                <span className={`pill ${humano ? 'pill-human' : 'pill-bot'}`}>
                  {humano ? '👤 humano' : '🤖 bot'}
                </span>
                {/* Resultado confirmado por un humano. Distinto de la etapa y del pedido
                    reconocido por el bot: "pagó" solo aparece si alguien lo registró. */}
                {d.resultadoEtiqueta
                  ? <span className="pill pill-resultado" title={d.resultadoFecha ? `Registrado el ${fmt(d.resultadoFecha)}` : undefined}>✓ {d.resultadoEtiqueta}</span>
                  : <span className="pill pill-sindato" title="Nadie ha registrado el resultado de una llamada todavía">resultado: no disponible</span>}
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
            <button className="btn" onClick={() => setDebriefOpen(true)} title="Registrar el resultado de una llamada (voz)">
              🎤 Debrief
            </button>
          )}
          {d && (
            <button className="btn" onClick={() => void toggleModo()} disabled={cambiandoModo}>
              {humano ? '🤖 Devolver al bot' : '✋ Tomar control'}
            </button>
          )}
        </div>
      </header>

      {debriefOpen && <LeadDebrief leadId={leadId} onClose={() => setDebriefOpen(false)} onSaved={refrescar} />}

      <div className="msgs" ref={msgsRef}>
        {convQ.isLoading && <div className="empty">Cargando conversación…</div>}
        {convQ.isError && <div className="empty">No se pudo cargar la conversación. Reintentando…</div>}
        {convQ.data?.page?.hayMas && convQ.data.page.cursor && (
          <button className="btn" onClick={() => void cargarAnterior()} disabled={loadingEarlierLead === leadId} style={{ alignSelf: 'center' }}>
            {loadingEarlierLead === leadId ? 'Cargando mensajes anteriores…' : 'Cargar mensajes anteriores'}
          </button>
        )}
        {convQ.data?.eventos.map(e => <EventItem key={conversationEventId(e)} ev={e} leadId={leadId} />)}
      </div>

      {ventanaCerrada && (
        <div className="ventana-cerrada">
          <div className="vc-texto">
            <strong>Este chat está cerrado.</strong> El cliente no escribe desde hace más de 24 h y
            Meta solo permite reabrirlo con una plantilla aprobada.
            {ventanaCerrada.plantilla
              ? ' Tu texto sigue abajo: se lo podrás enviar cuando el cliente conteste.'
              : ' Todavía no hay una plantilla de reapertura configurada — avisa al administrador.'}
          </div>
          <div className="vc-botones">
            {ventanaCerrada.plantilla && (
              <button className="btn btn-send" onClick={() => void reabrir()} disabled={reabriendo}>
                {reabriendo ? '…' : 'Enviar plantilla (se cobra)'}
              </button>
            )}
            <button className="btn" onClick={() => setVentanaCerrada(null)}>Cerrar</button>
          </div>
        </div>
      )}

      <div className="conv-input">
        <input
          value={texto}
          onChange={e => onTexto(e.target.value)}
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

// Marcador de media que persiste el webhook ("[📷 …]", "[🎙️ …]", "[📄 …]", "[🎬 …]"):
// si el adjunto ya se renderiza, el texto es redundante → lo ocultamos (pero conservamos
// los captions reales, que son palabras del lead).
function esMarcadorMedia(t: string): boolean {
  return /^\[(📷|🎙️|📄|🎬)/.test(t)
}

function EventItem({ ev, leadId }: { ev: ConversationEvent; leadId: number }) {
  if (ev.kind === 'state') {
    return <div className="state-pill" data-event-id={conversationEventId(ev)}>⦿ {ev.label} · {fmt(ev.at)}</div>
  }
  const cls = ev.origen === 'LEAD' ? 'in' : ev.origen === 'VENDEDOR' ? 'vendor' : 'bot'
  const mostrarTexto = ev.texto && !(ev.media && esMarcadorMedia(ev.texto))
  return (
    <div className={`bubble-row ${cls}`} data-event-id={conversationEventId(ev)}>
      <div className={`bubble ${cls}`}>
        {ev.origen !== 'LEAD' && <div className="bub-tag">{ev.origen}</div>}
        {ev.media && <Adjunto leadId={leadId} media={ev.media as MediaRef} />}
        {mostrarTexto && <div className="bub-text">{ev.texto}</div>}
        <div className="bub-time">{fmt(ev.at)} <Recibo ev={ev} /></div>
      </div>
    </div>
  )
}

// El recibo de Meta. Sin esto, un mensaje que Meta rechazó —fuera de la ventana de 24 h,
// número sin WhatsApp, plantilla no aprobada— se veía igual que uno entregado, y el
// vendedor descubría el problema cuando ya había perdido la venta.
function Recibo({ ev }: { ev: Extract<ConversationEvent, { kind: 'message' }> }) {
  if (!ev.estado) return null
  if (ev.estado === 'failed') {
    return (
      <span className="recibo recibo-falla" title={ev.estadoDetalle || 'Meta no pudo entregarlo'}>
        ⚠ no entregado
      </span>
    )
  }
  const marca = ev.estado === 'sent' ? '✓' : '✓✓'
  const titulo = ev.estado === 'sent' ? 'enviado' : ev.estado === 'delivered' ? 'entregado' : 'leído'
  return <span className={`recibo recibo-${ev.estado}`} title={titulo}>{marca}</span>
}

// Baja el adjunto con auth (object URL) y lo revoca al desmontar (evita fugas de memoria).
// La foto se ve, la nota de voz se escucha y el resto (PDF, video) se abre o se descarga:
// el vendedor ya no tiene que pedirle al lead que le reenvíe su comprobante.
function Adjunto({ leadId, media }: { leadId: number; media: MediaRef }) {
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
  if (error) return <div className="media-error">no se pudo cargar el adjunto</div>
  if (!src) return <div className="media-loading">cargando adjunto…</div>
  if (media.tipo === 'image') return <img className="media-img" src={src} alt="adjunto del lead" />
  if (media.tipo === 'audio') return <audio className="media-audio" src={src} controls preload="none" />
  if (media.tipo === 'video') return <video className="media-img" src={src} controls preload="metadata" />
  return (
    <a className="media-file" href={src} download target="_blank" rel="noreferrer">
      📄 abrir documento
    </a>
  )
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}