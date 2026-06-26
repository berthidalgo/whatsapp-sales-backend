// FlowCopilot — Hito D: el copiloto conversacional (texto + VOZ) para diseñar el flujo.
// El supervisor escribe o habla; un meta-agente (que conoce el cerebro) propone ediciones
// y AVISA si algo rompe los principios. El humano ve el preview y CONFIRMA (nunca silencioso).
// Voz: micrófono (MediaRecorder) → Whisper/Groq (STT) · respuesta → speechSynthesis (TTS gratis).
import { useState, useRef } from 'react'
import { api } from './api'
import { useToast } from './Toast'
import type { FlowEditMap } from '@shared/types'

type Msg = { rol: 'vendedor' | 'copiloto'; texto: string }

export default function FlowCopilot({ campaignId, onAplicar }: { campaignId: number | null; onAplicar: (edits: FlowEditMap) => void }) {
  const toast = useToast()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [grabando, setGrabando] = useState(false)
  const [propuesta, setPropuesta] = useState<{ edits: FlowEditMap; aviso: string | null } | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // TTS: el copiloto "habla" su respuesta (voz nativa del navegador, gratis).
  function hablar(texto: string) {
    try {
      window.speechSynthesis?.cancel()
      const u = new SpeechSynthesisUtterance(texto)
      u.lang = 'es-PE'
      window.speechSynthesis?.speak(u)
    } catch { /* sin TTS, no pasa nada */ }
  }

  async function enviar(texto: string) {
    const t = texto.trim()
    if (!t || enviando || campaignId == null) return
    setInput('')
    const historial = msgs.slice(-8)
    setMsgs(m => [...m, { rol: 'vendedor', texto: t }])
    setEnviando(true)
    try {
      const r = await api.flowCopilot(campaignId, t, historial)
      setMsgs(m => [...m, { rol: 'copiloto', texto: r.respuesta }])
      hablar(r.respuesta)
      const tieneEdits = r.edits && Object.keys(r.edits).length > 0
      setPropuesta(tieneEdits || r.aviso ? { edits: r.edits, aviso: r.aviso } : null)
    } catch {
      setMsgs(m => [...m, { rol: 'copiloto', texto: 'Uy, no pude procesar eso. Reintenta.' }])
    } finally { setEnviando(false) }
  }

  // Micrófono push-to-talk: graba → transcribe (Whisper) → manda como texto.
  async function toggleMic() {
    if (grabando) { recRef.current?.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(tr => tr.stop())
        setGrabando(false)
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        if (!blob.size) return
        setEnviando(true)
        try {
          const b64 = await blobABase64(blob)
          const { texto } = await api.transcribe(b64, 'audio/webm')
          setEnviando(false)
          if (texto) await enviar(texto)
          else toast('No te escuché bien, reintenta.')
        } catch { setEnviando(false); toast('No pude transcribir el audio.') }
      }
      recRef.current = rec
      rec.start()
      setGrabando(true)
    } catch { toast('No pude acceder al micrófono (revisa el permiso).') }
  }

  function aplicar() {
    if (!propuesta?.edits || !Object.keys(propuesta.edits).length) return
    onAplicar(propuesta.edits)
    setPropuesta(null)
    setMsgs(m => [...m, { rol: 'copiloto', texto: '✓ Aplicado al flujo. Revísalo y dale Guardar.' }])
  }

  const hayEdits = propuesta && Object.keys(propuesta.edits).length > 0

  return (
    <aside className="flow-copilot">
      <div className="fc-head">🎙️ Copiloto <span className="fc-sub">conversa para diseñar el flujo</span></div>
      <div className="fc-chat">
        {msgs.length === 0 && (
          <div className="fc-empty">Dime qué ajustar — ej: <em>"en la presentación, enfatiza el caso del alumno que exportó a Canadá"</em>. Escribe o usa el 🎤.</div>
        )}
        {msgs.map((m, i) => <div key={i} className={`fc-msg fc-${m.rol}`}>{m.texto}</div>)}
        {enviando && <div className="fc-msg fc-copiloto fc-typing">···</div>}
      </div>

      {propuesta && (
        <div className="fc-propuesta">
          {propuesta.aviso && <div className="fc-aviso">⚠️ {propuesta.aviso}</div>}
          {hayEdits && <>
            <div className="fc-prop-titulo">Cambios propuestos:</div>
            {Object.entries(propuesta.edits).map(([id, e]) => (
              <div key={id} className="fc-prop-item"><strong>{id}</strong>: {e.guidance || e.label}</div>
            ))}
            <button className="btn btn-send fc-aplicar" onClick={aplicar}>Aplicar al flujo</button>
          </>}
        </div>
      )}

      <div className="fc-input">
        <button className={`fc-mic${grabando ? ' rec' : ''}`} onClick={() => void toggleMic()} title={grabando ? 'Detener' : 'Hablar'}>
          {grabando ? '⏹' : '🎤'}
        </button>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void enviar(input) }}
          placeholder="Escribe o habla…"
          disabled={enviando}
        />
        <button className="btn btn-send" onClick={() => void enviar(input)} disabled={enviando || !input.trim()}>➤</button>
      </div>
    </aside>
  )
}

function blobABase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result).split(',')[1] || '')
    fr.onerror = rej
    fr.readAsDataURL(blob)
  })
}
