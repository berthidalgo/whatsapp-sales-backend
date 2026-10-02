// AgentPlayground — Configuración del bot desde el CRM (Hito B3) + copiloto opcional.
//
// QUÉ CAMBIA RESPECTO A LA PANTALLA ANTERIOR (y por qué):
//
//  · LA FICHA SE EDITA DESDE LA BD, no desde una maqueta local. Antes el "Preview en Vivo"
//    armaba una conversación ficticia con los valores del formulario y la enseñaba como si
//    fuera lo que el bot iba a decir. Ahora el botón Valida pide al SERVIDOR la validación
//    del borrador (POST /v2/agent-config/preview): sin escritura y sin llamar al modelo, y
//    el rótulo dice exactamente eso. Una simulación que se parece al bot pero no ES el bot
//    hace que un operador confíe en una ficha que en realidad no funciona.
//
//  · EL BORRADOR ES POR CAMPAÑA. Antes, cambiar de campaña en el selector repintaba el
//    formulario con lo que venía del servidor y el trabajo sin guardar desaparecía. El
//    estado vive en `editor-estado.ts`, que además impide que una respuesta tardía del
//    copiloto de la campaña A se aplique sobre el borrador de la B.
//
//  · 409/428 NO SE RESUELVEN A LA FUERZA. Un conflicto de versión muestra la ficha vigente
//    y deja el borrador intacto; el operador elige. `force` se envía únicamente en la
//    petición de BORRADO de un dato que existe, y solo después de que el operador confirma:
//    no es un permiso general (ver `pideBorrado`).
//
//  · NO HAY CIFRA DE COSTO INVENTADA. Antes la pantalla multiplicaba tokens por unos precios
//    fijos y lo llamaba "costo". Eso no es el gasto real (el proveedor no lo informa por
//    esta vía) y se quitó: se muestran los tokens que el proveedor devolvió, que sí son un
//    dato medido, y quien quiera el gasto lo consulta al proveedor.
//
//  · EL COPILOTO ES OPCIONAL. Toda la edición manual funciona sin él y sin créditos de IA.
import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, claveDeCache } from './api'
import { useToast } from './Toast'
import type { AuthUser, AgentConfigPreview } from '@shared/types'
import {
  Borradores, borradorDe, cargarFicha, editar, prepararGuardado, confirmarGuardado,
  descartarBorrador, aplicarPropuesta, PeticionCopiloto, pideBorrado,
} from './editor-estado'

type ChatMsg = { rol: 'copiloto' | 'vendedor'; texto: string }
type Tab = 'ficha' | 'disparo' | 'guion' | 'alta'

function blobABase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result).split(',')[1] || '')
    fr.onerror = rej
    fr.readAsDataURL(blob)
  })
}

export default function AgentPlayground({ user }: { user: AuthUser }) {
  const toast = useToast()
  const qc = useQueryClient()
  const scope = claveDeCache(user)
  const puedeEditar = user.role === 'ADMIN' || user.role === 'SUPERVISOR'

  const [campaignId, setCampaignId] = useState<number | null>(null)
  const campaignsQ = useQuery({ queryKey: scope.concat('campaigns'), queryFn: () => api.campaigns() })
  useEffect(() => {
    if (campaignId && campaignsQ.data?.some(c => c.id === campaignId)) return
    if (!campaignId && campaignsQ.data?.length) setCampaignId(campaignsQ.data[0].id)
  }, [campaignId, campaignsQ.data])

  const configQ = useQuery({
    queryKey: scope.concat('agentConfig', campaignId ?? 'sin-campana'),
    queryFn: () => api.agentConfig(campaignId!),
    enabled: !!campaignId,
  })
  const detailQ = useQuery({
    queryKey: scope.concat('campaignDetail', campaignId ?? 'sin-campana'),
    queryFn: () => api.campaignDetail(campaignId!),
    enabled: !!campaignId && puedeEditar,
  })

  // ── Borradores por campaña ────────────────────────────────────────────
  const [borradores, setBorradores] = useState<Borradores>({})
  const borrador = borradorDe(borradores, campaignId)
  const dirty = !!borrador?.dirty

  useEffect(() => {
    setBorradores(prev => cargarFicha(prev, configQ.data, campaignId).borradores)
  }, [configQ.data, campaignId])

  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [conflicto, setConflicto] = useState<{ version: number | null; factSheet: any; agente: any } | null>(null)
  const [validacion, setValidacion] = useState<(AgentConfigPreview & { etiqueta: string }) | null>(null)
  const [validando, setValidando] = useState(false)
  const [borrados, setBorrados] = useState<string[] | null>(null)

  const factSheet = borrador?.factSheet || {}
  const agente = borrador?.agente || {}

  const setFs = useCallback((key: string, val: any) => {
    setBorradores(prev => editar(prev, campaignId!, { factSheet: { ...(prev[campaignId!]?.factSheet || {}), [key]: val } }))
  }, [campaignId])
  const setFsSub = useCallback((parent: string, key: string, val: any) => {
    setBorradores(prev => {
      const b = prev[campaignId!]
      return editar(prev, campaignId!, { factSheet: { ...(b?.factSheet || {}), [parent]: { ...(b?.factSheet?.[parent] || {}), [key]: val } } })
    })
  }, [campaignId])
  const setAg = useCallback((key: string, val: any) => {
    setBorradores(prev => editar(prev, campaignId!, { agente: { ...(prev[campaignId!]?.agente || {}), [key]: val } }))
  }, [campaignId])

  // ── Guardar ───────────────────────────────────────────────────────────
  // El intento congela versión, contenido y revisión: si el operador escribe mientras
  // vuela, lo que escribió sigue pendiente (probado en editor-estado.test.mjs).
  const guardar = async (opts: { versionOverride?: number; force?: boolean } = {}) => {
    if (!campaignId || savingRef.current) return
    const intento = prepararGuardado(borradores, campaignId)
    if (!intento) return
    if (intento.version == null && opts.versionOverride == null) {
      toast('Ficha sin versión: recarga la pantalla para obtenerla.', 'error')
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      const r = await api.saveAgentConfig(
        intento.campaignId, intento.factSheet, intento.agente,
        opts.versionOverride ?? intento.version!, !!opts.force,
      )
      setBorradores(prev => {
        const resultado = confirmarGuardado(prev, intento, r.version)
        if (resultado.followUpsPendientes) {
          toast('Guardado. Lo que escribiste mientras guardaba sigue sin guardar.', 'info')
        }
        return resultado.borradores
      })
      setConflicto(null)
      setBorrados(null)
      toast('✅ Ficha guardada: es lo que va a leer el bot.', 'success')
      void qc.invalidateQueries({ queryKey: scope.concat('agentConfig', campaignId ?? 'sin-campana') })
      void qc.invalidateQueries({ queryKey: scope.concat('campaigns') })
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409 && typeof e.body?.version === 'number') {
          setConflicto({ version: e.body.version, factSheet: e.body.factSheet, agente: e.body.agente })
          toast('Otro supervisor guardó entremedio. Tu borrador sigue aquí: compáralo y elige.', 'error')
        } else if (e.status === 409 && e.body?.codigo === 'BORRADO_REQUIERE_CONFIRMACION') {
          // El servidor pide confirmación de borrado: se la pedimos a la persona, no se
          // reenvía con force a ciegas.
          setBorrados(pideBorrado(borrador!, configQ.data))
          toast('Hay datos que quieres eliminar. Confirma abajo si es intencional.', 'info')
        } else if (e.status === 428) {
          toast('Tu editor estaba desactualizado. Recarga la versión vigente.', 'error')
        } else if (e.status === 400) {
          toast(e.body?.detalles?.join?.(' · ') || e.message, 'error')
        } else {
          toast(e.message, 'error')
        }
      } else toast('Error al guardar', 'error')
    } finally { savingRef.current = false; setSaving(false) }
  }

  // ── Validar en el servidor (reemplaza al preview ficticio) ────────────
  const validar = async () => {
    if (!campaignId || !borrador) return
    setValidando(true)
    try {
      const r = await api.previewAgentConfig(campaignId, borrador.factSheet, borrador.agente)
      setValidacion({
        ...r,
        // Rótulo explícito: esto NO es una conversación real con el bot.
        etiqueta: 'Validación del servidor sobre tu borrador: comprueba el contrato y el precio que LEERÍA el bot. No genera mensajes ni llama a ningún modelo.',
      })
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'No se pudo validar el borrador.', 'error')
    } finally { setValidando(false) }
  }

  // ── Copiloto (opcional) ───────────────────────────────────────────────
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [, setPeticion] = useState<PeticionCopiloto | null>(null)
  const tokenRef = useRef(0)
  const [tokensUsados, setTokensUsados] = useState(0)
  const chatEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chatMsgs, chatLoading])

  const enviarMensaje = async (texto: string) => {
    const t = texto.trim()
    if (!t || chatLoading || !campaignId || !borrador) return
    setChatInput('')
    const historial = chatMsgs.slice(-8).map(m => ({ rol: m.rol, texto: m.texto }))
    setChatMsgs(prev => [...prev, { rol: 'vendedor', texto: t }])
    setChatLoading(true)
    // La petición queda amarrada a campaña Y revisión. Cuando vuelva, `aplicarPropuesta`
    // la descarta si el operador ya no está donde la pidió.
    const mia: PeticionCopiloto = { campaignId, revision: borrador.revision, token: ++tokenRef.current }
    setPeticion(mia)
    try {
      const r = await api.flowCopilot(campaignId, t, historial)
      setChatMsgs(prev => [...prev, { rol: 'copiloto', texto: r.respuesta }])
      // Tokens: dato REAL devuelto por el proveedor. No se convierte a "costo" con precios
      // inventados; el gasto se consulta al proveedor (ver nota del archivo).
      if (r.usage?.totalTokenCount) setTokensUsados(n => n + r.usage!.totalTokenCount)
      setBorradores(prev => aplicarPropuesta(prev, mia, campaignId, r.edits))
    } catch {
      setChatMsgs(prev => [...prev, { rol: 'copiloto', texto: '⚠️ No pude consultar al consultor. Puedes editar la ficha manualmente.' }])
    } finally { setChatLoading(false) }
  }

  const [tabActual, setTabActual] = useState<Tab>('ficha')
  const pestanas: [Tab, string][] = [
    ['ficha', '📇 Ficha'],
    ['disparo', '🎯 Cuándo aplica'],
    ['guion', '💬 Guion'],
    ['alta', '➕ Nueva campaña'],
  ]

  return (
    <div className="ap-container">
      <div className="ap-header">
        <div className="ap-header-title">
          <h2>⚙️ Configuración del bot</h2>
          <p>La ficha que lee el cerebro sale de aquí y vive en la base de datos.</p>
        </div>
        <div className="ap-actions">
          {/* Tokens, no "costo": lo que el proveedor devolvió, sin inventar precios. */}
          {tokensUsados > 0 && (
            <span className="ap-cost" title="Tokens devueltos por el proveedor en el copiloto. El gasto en dinero lo informa el proveedor, no esta pantalla.">
              🧾 {tokensUsados.toLocaleString('es-PE')} tokens (copiloto)
            </span>
          )}
          <select className="btn" disabled={saving} value={campaignId ?? ''} onChange={e => setCampaignId(Number(e.target.value))}>
            {campaignsQ.data?.map(c => <option key={c.id} value={c.id}>{c.nombre}{c.activa ? '' : ' (borrador)'}</option>)}
          </select>
          {puedeEditar && dirty && <button className="btn" onClick={() => setBorradores(prev => descartarBorrador(prev, campaignId, configQ.data))} disabled={saving}>Descartar</button>}
          {puedeEditar && (
            <>
              <button className="btn" onClick={() => void validar()} disabled={!dirty || validando}>
                {validando ? '⏳ Validando…' : '🔎 Validar con el servidor'}
              </button>
              <button className="btn btn-send" onClick={() => void guardar()} disabled={!dirty || saving}>
                {saving ? '⏳ Guardando…' : '💾 Guardar'}
              </button>
            </>
          )}
        </div>
      </div>

      {conflicto && (
        <div className="ap-conflict" role="alert">
          <strong>⚠️ Esta ficha cambió mientras la editabas.</strong>
          <p>Tu borrador sigue en el formulario, sin pisar nada. Elige qué guardar:</p>
          <div className="ap-conflict-acciones">
            <button className="btn btn-send" disabled={saving || conflicto.version === null} onClick={() => void guardar({ versionOverride: conflicto.version! })}>
              Guardar mi borrador sobre la versión del servidor
            </button>
            <button className="btn" onClick={() => setBorradores(prev => descartarBorrador(prev, campaignId, configQ.data as any))} disabled={saving}>
              Cargar la versión del servidor (descartar mi borrador)
            </button>
          </div>
        </div>
      )}

      {borrados && borrados.length > 0 && (
        <div className="ap-conflict" role="alert">
          <strong>⚠️ Vas a eliminar {borrados.length > 1 ? 'estos datos' : 'este dato'}: {borrados.join(', ')}.</strong>
          <p>Solo se confirma si es intencional. Esto no borra campos obligatorios: el servidor los rechaza igual.</p>
          <div className="ap-conflict-acciones">
            <button className="btn btn-send" disabled={saving} onClick={() => void guardar({ force: true })}>Sí, elimínalos</button>
            <button className="btn" onClick={() => setBorrados(null)} disabled={saving}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="ap-tabs">
        {pestanas.map(([id, label]) => (
          <button key={id} className={`ap-tab ${tabActual === id ? 'active' : ''}`} onClick={() => setTabActual(id)}>{label}</button>
        ))}
      </div>

      {tabActual === 'disparo' && (
        <Disparos campaignId={campaignId} detail={detailQ.data} puedeEditar={puedeEditar}
          onGuardado={() => { void qc.invalidateQueries({ queryKey: scope.concat('campaignDetail', campaignId ?? 'sin-campana') }); void qc.invalidateQueries({ queryKey: scope.concat('campaigns') }) }} />
      )}

      {tabActual === 'guion' && (
        <Guion campaignId={campaignId} detail={detailQ.data} puedeEditar={puedeEditar}
          onGuardado={() => void qc.invalidateQueries({ queryKey: scope.concat('campaignDetail', campaignId ?? 'sin-campana') })} />
      )}

      {tabActual === 'alta' && (
        <AltaCampana
          user={user}
          onCreada={id => {
            void qc.invalidateQueries({ queryKey: scope.concat('campaigns') })
            setCampaignId(id)
            setTabActual('ficha')
          }}
        />
      )}

      {tabActual === 'ficha' && (
        <div className="ap-split">
          <div className="ap-left">
            <div className="ap-section">
              <h3 className="ap-section-title">🏷️ Identidad del Agente</h3>
              <label className="ap-label">Nombre del Producto / Servicio
                <input className="ap-input" value={agente.nombreProducto || ''} onChange={e => setAg('nombreProducto', e.target.value)} placeholder="Nombre del programa" />
              </label>
              <label className="ap-label">Tono del Agente
                <select className="ap-input" value={agente.tono || 'amable'} onChange={e => setAg('tono', e.target.value)}>
                  <option value="amable">Amable y consultivo</option>
                  <option value="directo">Directo y al grano</option>
                </select>
              </label>
            </div>
            <div className="ap-section">
              <h3 className="ap-section-title">💰 Oferta y Precios</h3>
              <div className="ap-row">
                <label className="ap-label">Monto
                  <input type="number" className="ap-input" value={factSheet.precio?.monto ?? ''} onChange={e => setFsSub('precio', 'monto', Number(e.target.value))} placeholder="Monto" />
                </label>
                <label className="ap-label">Moneda
                  <input className="ap-input" value={factSheet.precio?.moneda || ''} onChange={e => setFsSub('precio', 'moneda', e.target.value)} placeholder="Moneda" />
                </label>
              </div>
              <label className="ap-label">Texto del precio (el que dirá al cliente)
                <input className="ap-input" value={factSheet.precio?.textoExacto || ''} onChange={e => setFsSub('precio', 'textoExacto', e.target.value)} placeholder="El precio exacto que dirá al cliente" />
              </label>
            </div>
            <div className="ap-section">
              <h3 className="ap-section-title">🎯 Público y propuesta</h3>
              <label className="ap-label">¿A quién le vendes?
                <textarea rows={2} className="ap-input" value={factSheet.publicoObjetivo || ''} onChange={e => setFs('publicoObjetivo', e.target.value)} placeholder="Ej. Pymes exportadoras de Latam…" />
              </label>
              <label className="ap-label">Propuesta de valor
                <textarea rows={2} className="ap-input" value={factSheet.propuestaValor || ''} onChange={e => setFs('propuestaValor', e.target.value)} placeholder="Ej. Acompañamiento 1:1 durante 12 sesiones…" />
              </label>
            </div>
            <div className="ap-section">
              <h3 className="ap-section-title">🔫 Contenido de la ficha</h3>
              <label className="ap-label">¿Qué incluye? (uno por línea)
                <textarea rows={3} className="ap-input" value={Array.isArray(factSheet.incluye) ? factSheet.incluye.join('\n') : ''} onChange={e => setFs('incluye', e.target.value.split('\n'))} placeholder={'Beneficio 1\nBeneficio 2'} />
              </label>
              <label className="ap-label">Lo que JAMÁS debe decir (uno por línea)
                <textarea rows={3} className="ap-input" value={Array.isArray(factSheet.reglasOro) ? factSheet.reglasOro.join('\n') : ''} onChange={e => setFs('reglasOro', e.target.value.split('\n'))} placeholder={'Nunca inventar descuentos\nNunca prometer resultados'} />
              </label>
              <p className="ap-note">
                Para borrar un dato existente márcalo como vacío y confirma arriba: el servidor
                no deja eliminar campos obligatorios aunque lo confirmes.
              </p>
            </div>
          </div>

          <div className="ap-simulator">
            <div className="sim-header">
              <h3>🔎 Qué leería el bot</h3>
              <span className="sim-badge">{dirty ? '⚡ Borrador sin guardar' : '✅ Sincronizado con la BD'}</span>
            </div>
            {validacion ? (
              <>
                <p className="sim-hint">{validacion.etiqueta}</p>
                <div className="sim-preview-cards">
                  <div className="sim-card">
                    <div className="sim-card-label">Producto</div>
                    <div className="sim-card-value">{agente.nombreProducto || <span className="sim-empty">Sin definir</span>}</div>
                  </div>
                  <div className="sim-card">
                    <div className="sim-card-label">Precio que dirá</div>
                    <div className="sim-card-value">{validacion.precioTexto || <span className="sim-empty">Sin precio (el bot hablará genérico)</span>}</div>
                  </div>
                </div>
                {validacion.errores?.length
                  ? <div className="ap-errores"><strong>Falta:</strong><ul>{validacion.errores.map(e => <li key={e}>{e}</li>)}</ul></div>
                  : <div className="ap-ok">✓ Cumple el contrato. Guarda para que el bot lo use.</div>}
              </>
            ) : (
              <div className="sim-placeholder">
                <p>Pulsa <strong>«Validar con el servidor»</strong> para comprobar tu borrador.</p>
                <p className="sim-hint">
                  Esta pantalla NO finge una conversación con el bot. Para ver cómo responde de verdad,
                  usa la conversación de un lead real (Inbox) o el copiloto.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="ap-bottom">
        <Copiloto
          campaignId={campaignId}
          puedeEditar={puedeEditar}
          disabled={!puedeEditar || !campaignId}
          mensajes={chatMsgs}
          cargando={chatLoading}
          entrada={chatInput}
          onEntrada={setChatInput}
          onEnviar={enviarMensaje}
          endRef={chatEndRef}
        />
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// ALTA DE CAMPAÑA DESDE EL CRM (Hito B3)
// ════════════════════════════════════════════════════════════════════════
//
// El recorrido que faltaba y que hace que "configurar el bot" sea posible sin scripts:
// crear BORRADOR → editar su ficha → validarla con el servidor → definir cuándo aplica y qué
// dice → activar.
//
// El borrador nace incompleto a propósito: una campaña sin ficha todavía es un estado de
// negocio válido y no se puede activar. Activar es una acción aparte, con su propio gate
// (ficha válida + trigger), y su 409 trae la lista de lo que falta: la pantalla la muestra
// tal cual en vez de un "no se pudo activar".
function AltaCampana({ user, onCreada }: { user: AuthUser; onCreada: (id: number) => void }) {
  const toast = useToast()
  const [nombre, setNombre] = useState('')
  const [slug, setSlug] = useState('')
  const [guardando, setGuardando] = useState(false)
  const puedeEditar = user.role === 'ADMIN' || user.role === 'SUPERVISOR'

  async function crear() {
    if (!nombre.trim() || guardando) return
    setGuardando(true)
    try {
      const r = await api.createCampaign({ nombre: nombre.trim(), slug: slug.trim() || undefined, borrador: true })
      toast('Campaña creada como borrador. Completa la ficha y actívala cuando esté lista.', 'success')
      onCreada(r.id)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'No se pudo crear la campaña.', 'error')
    } finally { setGuardando(false) }
  }

  if (!puedeEditar) return <div className="ap-note">Solo un ADMIN o SUPERVISOR puede crear campañas.</div>
  return (
    <div className="ap-section ap-alta">
      <h3 className="ap-section-title">➕ Crear campaña (borrador)</h3>
      <p className="ap-note">
        Nace como borrador: se puede dejar a medias. No atiende a nadie hasta que la actives,
        y para eso el servidor exige ficha válida y al menos un disparador.
      </p>
      <label className="ap-label">Nombre
        <input className="ap-input" value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Nombre de la nuevaacci\u00f3n" />
      </label>
      <label className="ap-label">Slug (opcional; único dentro de tu empresa)
        <input className="ap-input" value={slug} onChange={e => setSlug(e.target.value)} placeholder="SLUG-UNICO" />
      </label>
      <button className="btn btn-send" onClick={() => void crear()} disabled={!nombre.trim() || guardando}>
        {guardando ? '⏳ Creando…' : 'Crear borrador'}
      </button>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// DISPARADORES (triggers) — "cuándo aplica esta campaña"
// ════════════════════════════════════════════════════════════════════════
//
// Sin trigger una campaña nunca se asigna a un lead nuevo (salvo la campaña general). Por eso
// su alta sin uno se rechaza con el motivo exacto, no con un error genérico.
function Disparos({ campaignId, detail, puedeEditar, onGuardado }: {
  campaignId: number | null
  detail: any
  puedeEditar: boolean
  onGuardado: () => void
}) {
  const toast = useToast()
  const [texto, setTexto] = useState('')
  const [prueba, setPrueba] = useState('')
  const [resultado, setResultado] = useState<{ match: boolean; trigger: string | null } | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [motivoActivacion, setMotivoActivacion] = useState<string[] | null>(null)

  const triggers: { id: number; texto: string }[] = detail?.triggers ?? []

  async function agregar() {
    if (!campaignId || !texto.trim() || ocupado) return
    setOcupado(true)
    try {
      await api.addTrigger(campaignId, texto.trim())
      setTexto('')
      onGuardado()
    } catch (e) { toast(e instanceof ApiError ? e.message : 'No se pudo añadir el disparador.', 'error') }
    finally { setOcupado(false) }
  }

  async function quitar(id: number) {
    if (!campaignId) return
    try { await api.deleteTrigger(campaignId, id); onGuardado() }
    catch (e) { toast(e instanceof ApiError ? e.message : 'No se pudo quitar.', 'error') }
  }

  async function probar() {
    if (!campaignId || !prueba.trim()) return
    try { setResultado(await api.testTrigger(campaignId, prueba.trim())) }
    catch (e) { toast(e instanceof ApiError ? e.message : 'No se pudo probar.', 'error') }
  }

  async function activar() {
    if (!campaignId || ocupado) return
    setOcupado(true)
    setMotivoActivacion(null)
    try {
      await api.activateCampaign(campaignId)
      toast('Campaña activa: el bot ya la puede usar.', 'success')
      onGuardado()
    } catch (e) {
      // 409 = faltan cosas para activar. Se muestran, no se resumen como "error".
      if (e instanceof ApiError && e.status === 409) {
        setMotivoActivacion(Array.isArray(e.body?.detalles) ? e.body.detalles : [e.body?.error || e.message])
      } else toast(e instanceof ApiError ? e.message : 'No se pudo activar.', 'error')
    } finally { setOcupado(false) }
  }

  if (!campaignId) return <div className="ap-note">Elige una campaña.</div>
  return (
    <div className="ap-section">
      <h3 className="ap-section-title">🎯 ¿Cuándo aplica esta campaña?</h3>
      <p className="ap-note">
        Son las frases que hacen que un lead nuevo entre en esta campaña. Sin al menos una, no se
        puede activar (salvo la campaña general, que atiende a todos los que no encajan en otra).
      </p>
      <ul className="trg-list">
        {triggers.map(t => (
          <li key={t.id}>
            <span>{t.texto}</span>
            {puedeEditar && <button className="btn" onClick={() => void quitar(t.id)}>Quitar</button>}
          </li>
        ))}
        {triggers.length === 0 && <li className="empty">Todavía no hay disparadores.</li>}
      </ul>
      {puedeEditar && (
        <div className="ap-row">
          <input className="ap-input" value={texto} onChange={e => setTexto(e.target.value)} placeholder="Ej. info del taller de导出" />
          <button className="btn btn-send" onClick={() => void agregar()} disabled={!texto.trim() || ocupado}>Añadir</button>
        </div>
      )}
      <div className="ap-row ap-test">
        <input className="ap-input" value={prueba} onChange={e => setPrueba(e.target.value)} placeholder="Prueba: escribe algo que diría un cliente" />
        <button className="btn" onClick={() => void probar()} disabled={!prueba.trim()}>Ver si entra aquí</button>
      </div>
      {resultado && (
        <div className={resultado.match ? 'ap-ok' : 'ap-errores'}>
          {resultado.match ? `✓ Esta campaña capturaría el mensaje por "${resultado.trigger}".` : 'Este mensaje NO cae en esta campaña (puede entrar en otra o en la general).'}
        </div>
      )}
      {motivoActivacion && (
        <div className="ap-errores">
          <strong>Falta para activar:</strong>
          <ul>{motivoActivacion.map(m => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
      {puedeEditar && <button className="btn btn-send" onClick={() => void activar()} disabled={ocupado}>Activar campaña</button>}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// GUION (pasos del flujo)
// ════════════════════════════════════════════════════════════════════════
//
// Los pasos son mensajes, seguimientos o avisos, en orden. Se guardan como un conjunto
// (PUT /campaigns/:id/steps): o se guarda el guion completo o no se guarda nada, para no dejar
// la campaña con medio guion.
function Guion({ campaignId, detail, puedeEditar, onGuardado }: {
  campaignId: number | null
  detail: any
  puedeEditar: boolean
  onGuardado: () => void
}) {
  const toast = useToast()
  const [pasos, setPasos] = useState<{ tipo: string; mensaje: string; followupHrs?: number | null }[]>([])
  const [guardando, setGuardando] = useState(false)
  const cargados = useRef<number | null>(null)

  if (campaignId && cargados.current !== campaignId) {
    cargados.current = campaignId
    // eslint-disable-next-line react-hooks/rules-of-hooks
    queueMicrotask(() => setPasos((detail?.steps ?? []).map((s: any) => ({ tipo: s.tipo, mensaje: s.mensaje, followupHrs: s.followupHrs }))))
  }

  async function guardar() {
    if (!campaignId || guardando) return
    setGuardando(true)
    try {
      await api.saveSteps(campaignId, pasos)
      toast('Guion guardado.', 'success')
      onGuardado()
    } catch (e) {
      const detalles = e instanceof ApiError && Array.isArray((e.body as any)?.detalles) ? (e.body as any).detalles.join(' · ') : null
      toast(detalles || (e instanceof ApiError ? e.message : 'No se pudo guardar el guion.'), 'error')
    } finally { setGuardando(false) }
  }

  if (!campaignId) return <div className="ap-note">Elige una campaña.</div>
  return (
    <div className="ap-section">
      <h3 className="ap-section-title">💬 Guion de la campaña</h3>
      <p className="ap-note">Pasos en orden: un mensaje, un seguimiento o un aviso al vendedor.</p>
      {pasos.map((p, i) => (
        <div className="ap-row" key={i}>
          <select className="ap-input" value={p.tipo} disabled={!puedeEditar} onChange={e => setPasos(ps => ps.map((x, j) => j === i ? { ...x, tipo: e.target.value } : x))}>
            <option value="MSG">Mensaje al cliente</option>
            <option value="FOLLOWUP">Seguimiento</option>
            <option value="NOTIFY">Aviso al vendedor</option>
          </select>
          <input className="ap-input" value={p.mensaje} disabled={!puedeEditar} onChange={e => setPasos(ps => ps.map((x, j) => j === i ? { ...x, mensaje: e.target.value } : x))} />
          <button className="btn" disabled={!puedeEditar} onClick={() => setPasos(ps => ps.filter((_, j) => j !== i))}>Quitar</button>
        </div>
      ))}
      {puedeEditar && (
        <>
          <button className="btn" onClick={() => setPasos(ps => [...ps, { tipo: 'MSG', mensaje: '' }])}>Añadir paso</button>
          <button className="btn btn-send" onClick={() => void guardar()} disabled={guardando || pasos.length === 0}>
            {guardando ? '⏳ Guardando…' : 'Guardar guion'}
          </button>
        </>
      )}
    </div>
  )
}

function Copiloto({ campaignId, puedeEditar, disabled, mensajes, cargando, entrada, onEntrada, onEnviar, endRef }: {
  campaignId: number | null
  puedeEditar: boolean
  disabled: boolean
  mensajes: ChatMsg[]
  cargando: boolean
  entrada: string
  onEntrada: (v: string) => void
  onEnviar: (texto: string) => void
  endRef: React.RefObject<HTMLDivElement>
}) {
  const [grabando, setGrabando] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const toast = useToast()

  async function toggleMic() {
    if (grabando) { recRef.current?.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunks.current = []
      rec.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setGrabando(false)
        const blob = new Blob(chunks.current, { type: 'audio/webm' })
        if (!blob.size) return
        try {
          const { texto } = await api.transcribe(await blobABase64(blob), 'audio/webm')
          if (texto) onEnviar(texto)
        } catch { toast('No pude transcribir el audio.') }
      }
      recRef.current = rec
      rec.start()
      setGrabando(true)
    } catch { toast('No pude acceder al micrófono.') }
  }

  return (
    <div className="copilot-panel">
      <div className="fc-head">
        🎙️ Consultor (opcional)
        <span className="fc-sub">
          {puedeEditar
            ? 'Te propone cambios a la ficha. La edición manual funciona igual sin él.'
            : 'Solo ADMIN/SUPERVISOR edita la ficha.'}
        </span>
      </div>
      <div className="copilot-msgs">
        {mensajes.length === 0 && (
          <div className="fc-empty">Ej: <em>c\u00f3mo se llama el programa y qu\u00e9 incluye</em>. Propone, tú confirmas y guardas.</div>
        )}
        {mensajes.map((m, i) => (
          <div key={i} className={`copilot-msg-wrap ${m.rol}`}>
            <div className="copilot-avatar">{m.rol === 'copiloto' ? '🤖' : '👤'}</div>
            <div className="copilot-msg"><span className="copilot-role">{m.rol === 'copiloto' ? 'Consultor' : 'Tú'}</span>{m.texto}</div>
          </div>
        ))}
        {cargando && <div className="copilot-msg-wrap copiloto"><div className="copilot-avatar">🤖</div><div className="copilot-msg copilot-typing"><span className="dot" /><span className="dot" /><span className="dot" /></div></div>}
        <div ref={endRef} />
      </div>
      <div className="copilot-input-area">
        <button className={`fc-mic${grabando ? ' rec' : ''}`} onClick={() => void toggleMic()} disabled={disabled} title={grabando ? 'Detener' : 'Hablar'}>{grabando ? '⏹' : '🎤'}</button>
        <input className="ap-input" value={entrada} disabled={disabled || cargando} placeholder="Escribe una consulta…"
          onChange={e => onEntrada(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onEnviar(entrada) }} />
        <button className="btn btn-send" disabled={disabled || cargando || !entrada.trim()} onClick={() => onEnviar(entrada)}>➤</button>
      </div>
      <div className="fc-foot">
        Campaña: {campaignId ?? '—'}. Las propuestas se aplican solo a esta campaña y solo si no
        seguiste editando mientras respondía.
      </div>
    </div>
  )
}