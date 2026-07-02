import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { useToast } from './Toast'
import type { AuthUser } from '@shared/types'

type ChatMsg = { rol: 'copiloto' | 'vendedor'; texto: string }

function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== 'object') return target
  const out = { ...target }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    if (sv === null || sv === undefined) continue
    if (Array.isArray(sv)) {
      out[key] = sv
    } else if (typeof sv === 'object') {
      out[key] = deepMerge(out[key] || {}, sv)
    } else {
      out[key] = sv
    }
  }
  return out
}

function blobABase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result).split(',')[1] || '')
    fr.onerror = rej
    fr.readAsDataURL(blob)
  })
}

// ── Selector de Voz Premium ──────────────────────────────────────────
function elegirMejorVoz(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() || []
  
  // 1. Prioridad Absoluta: Microsoft Neural (Edge) u otras voces "Online/Natural"
  const neural = voices.find(v => v.lang.startsWith('es') && /online|natural|premium|neural/i.test(v.name))
  if (neural) return neural
  
  // 2. Segunda opción: Google (Mejor que Sabina)
  const google = voices.find(v => v.lang.startsWith('es') && /google/i.test(v.name))
  if (google) return google
  
  // 3. Fallback: cualquier voz en español que no sea la default robótica
  const esVoice = voices.find(v => v.lang.startsWith('es') && !v.localService) || voices.find(v => v.lang.startsWith('es'))
  return esVoice || null
}

// ══════════════════════════════════════════════════════════════════════
// VAD con Web Audio API nativa (sin ONNX, sin dependencias externas)
// Detecta silencio analizando el volumen RMS del micrófono cada 100ms.
// ══════════════════════════════════════════════════════════════════════
function useNativeVAD(opts: {
  onSpeechEnd: (blob: Blob) => void
  silenceMs?: number
  threshold?: number
}) {
  const { onSpeechEnd, silenceMs = 2500, threshold = 0.02 } = opts

  const [listening, setListening] = useState(false)
  const [userSpeaking, setUserSpeaking] = useState(false)
  const [errored, setErrored] = useState(false)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const silenceTimerRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const hasSpeechRef = useRef(false)

  const checkVolume = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)

    if (rms > threshold) {
      // Voz detectada
      setUserSpeaking(true)
      hasSpeechRef.current = true
      if (silenceTimerRef.current !== null) {
        clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }
    } else {
      // Silencio
      if (hasSpeechRef.current && silenceTimerRef.current === null) {
        silenceTimerRef.current = window.setTimeout(() => {
          // Fin de turno: parar grabación y enviar
          setUserSpeaking(false)
          hasSpeechRef.current = false
          silenceTimerRef.current = null
          const rec = recRef.current
          if (rec && rec.state === 'recording') {
            rec.stop()
          }
        }, silenceMs)
      }
    }
    rafRef.current = requestAnimationFrame(checkVolume)
  }, [threshold, silenceMs])

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const ctx = new AudioContext()
      ctxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      analyserRef.current = analyser

      // Iniciar grabación
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        chunksRef.current = []
        if (blob.size > 1000) { // Permitir palabras cortas como "Hola" o "Sí"
          onSpeechEnd(blob)
        }
        // Reiniciar grabación para el siguiente turno
        if (streamRef.current && streamRef.current.active) {
          startNewRecording()
        }
      }
      rec.start()
      recRef.current = rec

      setListening(true)
      setErrored(false)
      rafRef.current = requestAnimationFrame(checkVolume)
    } catch (e) {
      console.error('VAD start error:', e)
      setErrored(true)
    }
  }, [checkVolume, onSpeechEnd])

  const startNewRecording = useCallback(() => {
    if (!streamRef.current || !streamRef.current.active) return
    try {
      const rec = new MediaRecorder(streamRef.current, { mimeType: 'audio/webm' })
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        chunksRef.current = []
        if (blob.size > 1000) {
          onSpeechEnd(blob)
        }
        if (streamRef.current && streamRef.current.active) {
          startNewRecording()
        }
      }
      rec.start()
      recRef.current = rec
    } catch { /* stream might have ended */ }
  }, [onSpeechEnd])

  const pause = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    if (silenceTimerRef.current !== null) clearTimeout(silenceTimerRef.current)
    if (recRef.current && recRef.current.state === 'recording') {
      recRef.current.ondataavailable = null
      recRef.current.onstop = null
      recRef.current.stop()
    }
    if (ctxRef.current) ctxRef.current.suspend()
    setListening(false)
    setUserSpeaking(false)
    hasSpeechRef.current = false
  }, [])

  const resume = useCallback(() => {
    if (ctxRef.current && ctxRef.current.state === 'suspended') {
      ctxRef.current.resume()
    }
    hasSpeechRef.current = false
    setListening(true)
    startNewRecording()
    rafRef.current = requestAnimationFrame(checkVolume)
  }, [checkVolume, startNewRecording])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (silenceTimerRef.current !== null) clearTimeout(silenceTimerRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      ctxRef.current?.close()
    }
  }, [])

  return { listening, userSpeaking, errored, start, pause, resume }
}


// ══════════════════════════════════════════════════════════════════════
export default function AgentPlayground({ user }: { user: AuthUser }) {
  const [campaignId, setCampaignId] = useState<number | null>(null)
  const campaignsQ = useQuery({ queryKey: ['campaigns'], queryFn: () => api.campaigns() })

  useEffect(() => {
    if (!campaignId && campaignsQ.data?.length) setCampaignId(campaignsQ.data[0].id)
  }, [campaignId, campaignsQ.data])

  const configQ = useQuery({
    queryKey: ['agentConfig', campaignId],
    queryFn: () => api.agentConfig(campaignId!),
    enabled: !!campaignId,
  })

  const [factSheet, setFactSheet] = useState<any>({})
  const [agente, setAgente] = useState<any>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [flashFields, setFlashFields] = useState<Set<string>>(new Set())
  const toast = useToast()
  const qc = useQueryClient()

  useEffect(() => {
    if (configQ.data) {
      setFactSheet(configQ.data.factSheet || {})
      setAgente(configQ.data.agente || {})
      setDirty(false)
    }
  }, [configQ.data])

  const setFs = (key: string, val: any) => { setFactSheet((p: any) => ({ ...p, [key]: val })); setDirty(true) }
  const setFsSub = (parent: string, key: string, val: any) => {
    setFactSheet((p: any) => ({ ...p, [parent]: { ...p[parent], [key]: val } }))
    setDirty(true)
  }
  const setAg = (key: string, val: any) => { setAgente((p: any) => ({ ...p, [key]: val })); setDirty(true) }

  const [tab, setTab] = useState<'crear' | 'configurar'>('crear')
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([
    { rol: 'copiloto', texto: '¡Hola! Soy tu Consultor IA 🤖. Haz clic en el orbe verde para iniciar nuestra llamada.' }
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [sessionCost, setSessionCost] = useState(0)
  const [botSpeaking, setBotSpeaking] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (window.speechSynthesis) window.speechSynthesis.getVoices()
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMsgs, chatLoading])

  const flashField = useCallback((fieldName: string) => {
    setFlashFields(prev => new Set(prev).add(fieldName))
    setTimeout(() => setFlashFields(prev => { const next = new Set(prev); next.delete(fieldName); return next }), 2000)
  }, [])

  // ── Enviar mensaje al copiloto ─────────────────────────────
  const enviarMensaje = async (textoForzado?: string) => {
    const msg = (textoForzado || chatInput).trim()
    if (!msg || chatLoading || !campaignId) return
    setChatInput('')
    setChatMsgs(prev => [...prev, { rol: 'vendedor', texto: msg }])
    setChatLoading(true)

    try {
      const historial = chatMsgs.map(m => ({ rol: m.rol, texto: m.texto }))
      const r = await api.flowCopilot(campaignId, msg, historial)

      setChatMsgs(prev => [...prev, { rol: 'copiloto', texto: r.respuesta }])
      hablar(r.respuesta)

      if (r.usage) {
        // Asumiendo costo base similar a Gemini o Llama
        const inCostUSD = (r.usage.promptTokenCount / 1000000) * 0.60
        const outCostUSD = (r.usage.candidatesTokenCount / 1000000) * 1.80
        const costPEN = (inCostUSD + outCostUSD) * 3.75 // Conversión a Soles
        setSessionCost(prev => prev + costPEN)
      }

      if (r.edits) {
        const edits = r.edits
        if (edits.factSheet && Object.keys(edits.factSheet).length) {
          setFactSheet((prev: any) => deepMerge(prev, edits.factSheet))
          Object.keys(edits.factSheet).forEach(k => flashField(`fs-${k}`))
          setDirty(true)
        }
        if (edits.agente && Object.keys(edits.agente).length) {
          setAgente((prev: any) => deepMerge(prev, edits.agente))
          Object.keys(edits.agente).forEach(k => flashField(`ag-${k}`))
          setDirty(true)
        }
      }
    } catch {
      setChatMsgs(prev => [...prev, { rol: 'copiloto', texto: '⚠️ Error de conexión.' }])
    } finally {
      setChatLoading(false)
    }
  }

  // ── TTS con voz premium (sin emojis) ───────────────────────
  function hablar(texto: string) {
    if (!window.speechSynthesis) return
    window.speechSynthesis.cancel()
    // Limpiar emojis y caracteres especiales para que no los "diga" en voz alta
    const textoLimpio = texto
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (!textoLimpio) return
    const u = new SpeechSynthesisUtterance(textoLimpio)
    const bestVoice = elegirMejorVoz()
    if (bestVoice) u.voice = bestVoice
    else u.lang = 'es-ES'
    u.rate = 1.1 // Un poco más ágil, menos lectura
    u.pitch = 0.9 // Tono ligeramente más profundo y menos robótico
    u.onstart = () => {
      setBotSpeaking(true)
      vad.pause()
    }
    u.onend = () => {
      setBotSpeaking(false)
      vad.resume()
    }
    window.speechSynthesis.speak(u)
  }

  // ── VAD Nativo (Web Audio API) ─────────────────────────────
  const vad = useNativeVAD({
    silenceMs: 2500,
    threshold: 0.02,
    onSpeechEnd: async (blob) => {
      if (chatLoading || botSpeaking) return
      setChatLoading(true)
      try {
        const b64 = await blobABase64(blob)
        let { texto } = await api.transcribe(b64, 'audio/webm')

        // ── Filtro Anti-Alucinaciones Forense (Whisper Silence Hallucinations) ──
        const txtL = (texto || '').toLowerCase()
        const alucinaciones = [
          'enfim, el sistema de whatsapp',
          'terminos comunes',
          'términos comunes',
          'subtítulos realizados por',
          'gracias por su atención',
          'suscríbete',
          'gracias por ver',
          'amigos y amigas'
        ]
        if (alucinaciones.some(h => txtL.includes(h)) || txtL.trim().length < 4) {
          console.warn('Ruido/Alucinación filtrada:', texto)
          texto = ''
        }

        if (texto && texto.trim()) {
          await enviarMensaje(texto)
        } else {
          setChatLoading(false)
        }
      } catch {
        setChatLoading(false)
        toast('Error al procesar tu voz.', 'error')
      }
    }
  })

  // ── Guardar / Descartar ────────────────────────────────────
  const guardar = async () => {
    if (!campaignId) return
    setSaving(true)
    try {
      await api.saveAgentConfig(campaignId, factSheet, agente)
      toast('✅ Configuración guardada en el cerebro del agente', 'success')
      setDirty(false)
      qc.invalidateQueries({ queryKey: ['agentConfig', campaignId] })
    } catch { toast('Error al guardar', 'error') } finally { setSaving(false) }
  }

  const descartar = () => {
    setFactSheet(configQ.data?.factSheet || {})
    setAgente(configQ.data?.agente || {})
    setDirty(false)
  }

  const puedeEditar = user.role === 'ADMIN' || user.role === 'SUPERVISOR'
  const fc = (id: string) => flashFields.has(id) ? 'ap-input ap-flash' : 'ap-input'

  // ── Orb State Logic ────────────────────────────────────────
  let orbClass = 'orb-idle'
  let statusText = 'Haz clic en el orbe para iniciar la llamada'

  if (vad.errored) {
    orbClass = 'orb-idle'
    statusText = '⚠️ No se pudo acceder al micrófono. Permite el acceso y refresca.'
  } else if (vad.listening) {
    if (vad.userSpeaking) {
      orbClass = 'orb-speaking'
      statusText = 'Te estoy escuchando...'
    } else {
      orbClass = 'orb-listening'
      statusText = 'Esperando tu voz...'
    }
  }
  if (chatLoading) {
    orbClass = 'orb-processing'
    statusText = 'Pensando...'
  }
  if (botSpeaking) {
    orbClass = 'orb-bot'
    statusText = 'El Consultor está hablando...'
  }

  return (
    <div className="ap-container">
      <div className="ap-header">
        <div className="ap-header-title">
          <h2>🧠 Agent Playground</h2>
          <p>Consultoría conversacional — habla con tu Agente IA</p>
        </div>
        <div className="ap-actions">
          <div className="ap-cost" title="Costo estimado de tokens en esta sesión (Soles)">
            💰 S/ {sessionCost.toFixed(4)}
          </div>
          <select className="btn" value={campaignId ?? ''} onChange={e => setCampaignId(Number(e.target.value))}>
            {campaignsQ.data?.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
          {puedeEditar && (
            <>
              <button className="btn btn-send" onClick={guardar} disabled={!dirty || saving}>
                {saving ? '⏳ Guardando...' : '💾 Guardar'}
              </button>
              {dirty && <button className="btn" onClick={descartar}>Descartar</button>}
            </>
          )}
        </div>
      </div>

      <div className="ap-split">
        <div className="ap-left">
          <div className="ap-tabs">
            <button className={`ap-tab ${tab === 'crear' ? 'active' : ''}`} onClick={() => setTab('crear')}>
              📞 Llamada Consultiva
            </button>
            <button className={`ap-tab ${tab === 'configurar' ? 'active' : ''}`} onClick={() => setTab('configurar')}>
              ⚙️ Configurar Manual
            </button>
          </div>

          {tab === 'crear' ? (
            <div className="copilot-chat">
              <div className="copilot-msgs">
                {chatMsgs.map((m, i) => (
                  <div key={i} className={`copilot-msg-wrap ${m.rol}`}>
                    <div className="copilot-avatar">{m.rol === 'copiloto' ? '🤖' : '👤'}</div>
                    <div className="copilot-msg">
                      <span className="copilot-role">{m.rol === 'copiloto' ? 'Consultor IA' : 'Tú'}</span>
                      {m.texto}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="copilot-msg-wrap copiloto">
                    <div className="copilot-avatar">🤖</div>
                    <div className="copilot-msg copilot-typing">
                      <span className="dot"></span><span className="dot"></span><span className="dot"></span>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* ── Orbe Premium + Input de texto ── */}
              <div className="vad-orb-wrapper">
                <button
                  className={`vad-orb ${orbClass}`}
                  onClick={() => vad.listening ? vad.pause() : vad.start()}
                  title={vad.listening ? "Pausar llamada" : "Iniciar llamada"}
                />
                <div className="orb-status">{statusText}</div>
              </div>

              <div className="copilot-input-area">
                <input
                  type="text"
                  className="ap-input"
                  placeholder="O escribe aquí si prefieres..."
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && enviarMensaje()}
                  disabled={chatLoading}
                />
                <button className="btn btn-send" onClick={() => enviarMensaje()} disabled={chatLoading || !chatInput.trim()}>
                  Enviar
                </button>
              </div>
            </div>
          ) : (
            <div className="ap-config">
              <div className="ap-section">
                <h3 className="ap-section-title">🏷️ Identidad del Agente</h3>
                <label className="ap-label">Nombre del Producto / Servicio
                  <input type="text" className={fc('ag-nombreProducto')} value={agente.nombreProducto || ''} onChange={e => setAg('nombreProducto', e.target.value)} placeholder="Ej. Programa Exportador Pro" />
                </label>
                <label className="ap-label">Tono del Agente
                  <select className={fc('ag-tono')} value={agente.tono || 'amable'} onChange={e => setAg('tono', e.target.value)}>
                    <option value="amable">Amable y consultivo</option>
                    <option value="directo">Directo y al grano</option>
                    <option value="agresivo">Agresivo comercial</option>
                  </select>
                </label>
              </div>

              <div className="ap-section">
                <h3 className="ap-section-title">🎯 Público Objetivo</h3>
                <label className="ap-label">¿A quién le vendes?
                  <textarea className={fc('fs-publicoObjetivo')} rows={2} value={factSheet.publicoObjetivo || ''} onChange={e => setFs('publicoObjetivo', e.target.value)} placeholder="Ej. Pymes exportadoras de Latam..." />
                </label>
                <label className="ap-label">Propuesta de Valor Única
                  <textarea className={fc('fs-propuestaValor')} rows={2} value={factSheet.propuestaValor || ''} onChange={e => setFs('propuestaValor', e.target.value)} placeholder="Ej. El único programa con mentoría 1:1..." />
                </label>
              </div>

              <div className="ap-section">
                <h3 className="ap-section-title">💰 Oferta y Precios</h3>
                <div className="ap-row">
                  <label className="ap-label">Monto
                    <input type="number" className={fc('fs-precio')} value={factSheet.precio?.monto || ''} onChange={e => setFsSub('precio', 'monto', Number(e.target.value))} placeholder="99" />
                  </label>
                  <label className="ap-label">Moneda
                    <input type="text" className={fc('fs-precio')} value={factSheet.precio?.moneda || ''} onChange={e => setFsSub('precio', 'moneda', e.target.value)} placeholder="USD" />
                  </label>
                </div>
                <label className="ap-label">Texto Promocional
                  <input type="text" className={fc('fs-precio')} value={factSheet.precio?.textoExacto || ''} onChange={e => setFsSub('precio', 'textoExacto', e.target.value)} placeholder="~S/ 757~ → S/ 457" />
                </label>
              </div>

              <div className="ap-section">
                <h3 className="ap-section-title">🔫 Munición de Ventas</h3>
                <label className="ap-label">¿Qué incluye?
                  <textarea className={fc('fs-incluye')} rows={3} value={Array.isArray(factSheet.incluye) ? factSheet.incluye.join('\n') : ''} onChange={e => setFs('incluye', e.target.value.split('\n'))} placeholder="Beneficio 1&#10;Beneficio 2..." />
                </label>
                <label className="ap-label">FAQ — Objeciones comunes
                  <textarea className={fc('fs-faqs')} rows={4} value={Array.isArray(factSheet.faqs) ? factSheet.faqs.join('\n') : ''} onChange={e => setFs('faqs', e.target.value.split('\n'))} placeholder="¿Dan certificado? Sí.&#10;¿Hay devoluciones? Sí, 7 días." />
                </label>
              </div>

              <div className="ap-section">
                <h3 className="ap-section-title">🚫 Reglas de Oro</h3>
                <label className="ap-label">Lo que JAMÁS debe decir o hacer (una por línea)
                  <textarea className={fc('fs-reglasOro')} rows={3} value={Array.isArray(factSheet.reglasOro) ? factSheet.reglasOro.join('\n') : ''} onChange={e => setFs('reglasOro', e.target.value.split('\n'))} placeholder="Nunca inventar descuentos&#10;Nunca dar cuenta bancaria" />
                </label>
              </div>
            </div>
          )}
        </div>

        <div className="ap-simulator">
          <div className="sim-header">
            <h3>📱 Preview en Vivo</h3>
            <span className="sim-badge">{dirty ? '⚡ Sin guardar' : '✅ Sincronizado'}</span>
          </div>
          <div className="sim-preview-cards">
            <div className="sim-card">
              <div className="sim-card-label">Producto</div>
              <div className="sim-card-value">{agente.nombreProducto || <span className="sim-empty">Sin definir</span>}</div>
            </div>
            <div className="sim-card">
              <div className="sim-card-label">Precio</div>
              <div className="sim-card-value">{factSheet.precio?.textoExacto || (factSheet.precio?.monto ? `${factSheet.precio?.moneda || ''} ${factSheet.precio.monto}` : <span className="sim-empty">Sin definir</span>)}</div>
            </div>
            <div className="sim-card">
              <div className="sim-card-label">Tono</div>
              <div className="sim-card-value">{agente.tono || 'amable'}</div>
            </div>
            <div className="sim-card">
              <div className="sim-card-label">Público</div>
              <div className="sim-card-value">{factSheet.publicoObjetivo || <span className="sim-empty">Sin definir</span>}</div>
            </div>
          </div>
          <div className="sim-chat">
            <div className="sim-msg-wrap bot">
              <div className="sim-msg">¡Hola! 👋 Te cuento sobre <b>{agente.nombreProducto || 'nuestro programa'}</b>. {factSheet.propuestaValor ? factSheet.propuestaValor : '¿Te interesaría conocer los detalles?'}</div>
            </div>
            <div className="sim-msg-wrap user">
              <div className="sim-msg">¿Cuánto cuesta?</div>
            </div>
            <div className="sim-msg-wrap bot">
              <div className="sim-msg">
                {factSheet.precio?.textoExacto
                  ? <>El precio actual es <b>{factSheet.precio.textoExacto}</b>. ¿Te gustaría reservar?</>
                  : factSheet.precio?.monto
                    ? <>La inversión es de <b>{factSheet.precio.moneda || ''} {factSheet.precio.monto}</b>. ¿Reservamos?</>
                    : <>Déjame consultarte el precio con un asesor. ¿Mientras te cuento qué incluye?</>
                }
              </div>
            </div>
          </div>
          <div className="sim-footer-hint">💡 Se actualiza en tiempo real mientras conversas.</div>
        </div>
      </div>
    </div>
  )
}
