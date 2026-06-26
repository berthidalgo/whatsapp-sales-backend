// LeadDebrief — el vendedor DICTA cómo le fue en la llamada (o escribe); el cerebro
// (backend) lo estructura; el vendedor revisa/edita y guarda al CRM (CallEvent).
// El front solo captura voz + muestra: toda la inteligencia está en el back.
import { useState, useRef } from 'react'
import { api } from './api'
import { useToast } from './Toast'
import type { DebriefPreview } from '@shared/types'

const OUTCOMES: { v: string; l: string }[] = [
  { v: 'interesado', l: 'Interesado' }, { v: 'agendado', l: 'Agendado' },
  { v: 'pensándolo', l: 'Pensándolo' }, { v: 'pidió_info', l: 'Pidió info' },
  { v: 'no_contesta', l: 'No contesta' }, { v: 'no_interesado', l: 'No interesado' },
  { v: 'pagó', l: 'Pagó' }, { v: 'otro', l: 'Otro' },
]

export default function LeadDebrief({ leadId, onClose, onSaved }: { leadId: number; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [nota, setNota] = useState('')
  const [grabando, setGrabando] = useState(false)
  const [procesando, setProcesando] = useState(false)
  const [preview, setPreview] = useState<DebriefPreview | null>(null)
  const [guardando, setGuardando] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function analizar(texto: string) {
    const t = texto.trim()
    if (!t) return
    setProcesando(true)
    try { setPreview(await api.debrief(leadId, t)) }
    catch { toast('No pude estructurar el debrief.') }
    finally { setProcesando(false) }
  }

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
        setProcesando(true)
        try {
          const b64 = await blobABase64(blob)
          const { texto } = await api.transcribe(b64, 'audio/webm')
          setProcesando(false)
          if (texto) { setNota(texto); await analizar(texto) }
          else toast('No te escuché bien, reintenta.')
        } catch { setProcesando(false); toast('No pude transcribir el audio.') }
      }
      recRef.current = rec
      rec.start()
      setGrabando(true)
    } catch { toast('No pude acceder al micrófono.') }
  }

  async function guardar() {
    if (!preview || guardando) return
    setGuardando(true)
    try { await api.saveDebrief(leadId, preview); toast('Debrief guardado en el CRM.', 'success'); onSaved(); onClose() }
    catch { toast('No se pudo guardar el debrief.') }
    finally { setGuardando(false) }
  }

  function set<K extends keyof DebriefPreview>(k: K, v: DebriefPreview[K]) {
    setPreview(p => p ? { ...p, [k]: v } : p)
  }

  return (
    <div className="debrief-overlay" onClick={onClose}>
      <div className="debrief-card" onClick={e => e.stopPropagation()}>
        <div className="db-head">
          <span>🎤 Debrief de la llamada</span>
          <button className="fe-x" onClick={onClose} title="Cerrar">✕</button>
        </div>
        <div className="db-sub">Dicta cómo te fue (o escribe) y el sistema lo estructura para el CRM.</div>

        <div className="db-dictado">
          <button className={`fc-mic${grabando ? ' rec' : ''}`} onClick={() => void toggleMic()} title={grabando ? 'Detener' : 'Grabar'}>
            {grabando ? '⏹' : '🎤'}
          </button>
          <textarea className="fe-textarea" rows={3} value={nota} placeholder="…tu resumen de la llamada…"
            onChange={e => setNota(e.target.value)} />
        </div>
        <button className="btn db-analizar" onClick={() => void analizar(nota)} disabled={!nota.trim() || procesando}>
          {procesando ? 'Procesando…' : 'Analizar'}
        </button>

        {preview && (
          <div className="db-preview">
            <label className="fe-label">Resultado</label>
            <select className="fe-input" value={preview.outcome} onChange={e => set('outcome', e.target.value)}>
              {OUTCOMES.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
            <label className="fe-label">Objeción</label>
            <input className="fe-input" value={preview.objecion ?? ''} onChange={e => set('objecion', e.target.value || null)} placeholder="—" />
            <label className="fe-label">Próximo paso</label>
            <input className="fe-input" value={preview.proximoPaso ?? ''} onChange={e => set('proximoPaso', e.target.value || null)} placeholder="—" />
            {preview.fechaISO && <div className="db-fecha">📅 {fmtFecha(preview.fechaISO)}</div>}
            <label className="fe-label">Resumen</label>
            <textarea className="fe-textarea" rows={3} value={preview.resumen} onChange={e => set('resumen', e.target.value)} />
            <button className="btn btn-send db-guardar" onClick={() => void guardar()} disabled={guardando}>
              {guardando ? '…' : 'Guardar en el CRM'}
            </button>
          </div>
        )}
      </div>
    </div>
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

function fmtFecha(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-PE', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
