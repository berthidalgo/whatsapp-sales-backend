// src/webhook/debounce.js — Hidata v20 Día 7
//
// DEBOUNCE MANAGER
//
// Acumula mensajes consecutivos del mismo lead en una ventana de 6s.
// Cuando expira el timer (sin nuevos mensajes), procesa TODO junto.
//
// Caso típico que resuelve:
//   T+0:  "hola"
//   T+2:  "soy juan"
//   T+5:  "vendo palta hass"
//   T+14: timer expira → procesa "hola\nsoy juan\nvendo palta hass" como UN turno
//
// Beneficios:
//   - 1 sola llamada a Perception (vs 3)
//   - 1 sola respuesta al lead (vs spam)
//   - 3x menos costo en Vertex AI
//   - UX más natural (bot percibe la idea completa, no fragmentada)
//
// Implementación: Map<leadId, { buffer: [], timer: timeoutId }>
//
// API pública:
//   - enqueueMessage({ leadId, text, processFn, metadata })
//   - cancelDebounce(leadId) → cuando vendor responde manual
//   - getActiveDebounces() → para debug

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
const DEBOUNCE_WINDOW_MS = 6000               // OPTIMIZACIÓN LATENCIA (jun 2026): 11s→6s. El peritaje forense mostró que los 11s fijos eran el chunk MÁS grande de la latencia (de ~27s/turno con 2.5-pro). Los mensajes "varios enter" del lead llegan en 1-2s entre sí, así que 6s los agrupa de sobra y ahorra ~5s por respuesta. La protección anti-duplicado real es el LOCK que reencola (handler), no esta ventana. (Antes: 9s→11s por BUG A, pero el margen extra costaba latencia sin beneficio real.)
const MAX_BUFFER_PER_LEAD = 20                // Máximo mensajes acumulados
const MAX_ACTIVE_LEADS = 500                  // Cap defensivo

// ════════════════════════════════════════════════════════
// ESTADO INTERNO (singleton del proceso)
// ════════════════════════════════════════════════════════
const debounceState = new Map()
// Estructura: leadId → {
//   buffer: [{ text, timestamp, metadata }],
//   timer: timeoutId,
//   firstMessageAt: timestamp,
//   processFn: function
// }

// ════════════════════════════════════════════════════════
// KILL-STALE (Paso 2 — anti-cascade) — generación monotónica por lead
// ════════════════════════════════════════════════════════
// El problema: el cerebro tarda ~18s pero la ventana de debounce es 6s. Si el lead
// manda un mensaje MIENTRAS el cerebro piensa, el pipeline en vuelo igual enviaba su
// respuesta y luego el mensaje nuevo generaba OTRA → 2 mensajes en cascada (incidente
// real con Óscar: 2 Enter → 2 respuestas, cada una con su pregunta).
//
// El fix: cada mensaje nuevo del lead INCREMENTA esta generación. El pipeline captura
// la generación al ARRANCAR (getMessageGeneration) y, antes de ENVIAR, si la generación
// actual es MAYOR (llegó algo nuevo mientras pensaba) DESCARTA su respuesta obsoleta —
// el mensaje nuevo (ya encolado en el buffer) producirá la respuesta final que lee TODO.
//
// MUTE-SAFE: un bump SIEMPRE ocurre dentro de enqueueMessage, que SIEMPRE bufferea el
// mensaje → si descartamos, hay garantizado un mensaje encolado que se procesará. Jamás
// queda mudo. SINGLE-INSTANCE: Render corre 1 instancia → la memoria es la fuente de
// verdad compartida (multi-instancia futuro → mover a Redis, igual que el debounce/lock).
//
// Mapa con poda por TTL (mismo patrón que idempotency.js): el TTL (10min) >> lo que dura
// un turno (<1min) → JAMÁS poda algo en vuelo. Se poda perezoso al crecer (sin timer).
const messageGeneration = new Map()   // leadId → { gen, touched }
const GENERATION_TTL_MS = 10 * 60 * 1000
const GENERATION_PRUNE_AT = 1000      // poda perezosa cuando el mapa pasa este tamaño

function pruneGenerations() {
  const now = Date.now()
  for (const [leadId, v] of messageGeneration.entries()) {
    if (now - v.touched > GENERATION_TTL_MS) messageGeneration.delete(leadId)
  }
}

// Incrementa la generación del lead (un mensaje nuevo llegó). Devuelve la nueva.
function bumpGeneration(leadId) {
  if (messageGeneration.size > GENERATION_PRUNE_AT) pruneGenerations()
  const gen = (messageGeneration.get(leadId)?.gen || 0) + 1
  messageGeneration.set(leadId, { gen, touched: Date.now() })
  return gen
}

/**
 * Generación actual del lead. El pipeline la captura al arrancar y la re-chequea antes
 * de enviar: si subió, su respuesta quedó obsoleta (llegó un mensaje nuevo) → descártala.
 * @param {number} leadId
 * @returns {number} generación (0 si el lead nunca encoló)
 */
export function getMessageGeneration(leadId) {
  return messageGeneration.get(leadId)?.gen || 0
}

// ════════════════════════════════════════════════════════
// API PÚBLICA — enqueueMessage()
// ════════════════════════════════════════════════════════

/**
 * Acumula un mensaje en el buffer del lead.
 * Si ya hay timer activo, lo cancela y crea uno nuevo.
 * Si el timer expira sin nuevos mensajes, ejecuta processFn con el buffer completo.
 * 
 * @param {object} params
 * @param {number} params.leadId - ID del lead
 * @param {string} params.text - Texto del mensaje recibido
 * @param {function} params.processFn - async (combinedText, bufferMetadata) => void
 * @param {object} params.metadata - Metadata opcional del mensaje
 * @returns {object} { queued: boolean, bufferSize: number, willProcessIn: ms }
 */
export function enqueueMessage({ leadId, text, processFn, metadata = {} }) {
  if (!leadId) {
    console.warn('[Debounce] enqueueMessage: leadId is required')
    return { queued: false, error: 'leadId required' }
  }

  if (!text || typeof text !== 'string') {
    console.warn(`[Debounce] enqueueMessage: invalid text for lead ${leadId}`)
    return { queued: false, error: 'text required' }
  }

  if (typeof processFn !== 'function') {
    console.warn(`[Debounce] enqueueMessage: processFn must be function`)
    return { queued: false, error: 'processFn required' }
  }

  // ─── Cap defensivo de leads activos ───
  if (!debounceState.has(leadId) && debounceState.size >= MAX_ACTIVE_LEADS) {
    console.warn(`[Debounce] Reached MAX_ACTIVE_LEADS (${MAX_ACTIVE_LEADS}), rejecting new lead ${leadId}`)
    return { queued: false, error: 'max_active_leads_reached' }
  }

  // ─── Obtener o crear estado del lead ───
  let leadDebounce = debounceState.get(leadId)
  
  if (!leadDebounce) {
    leadDebounce = {
      buffer: [],
      timer: null,
      firstMessageAt: Date.now(),
      processFn
    }
    debounceState.set(leadId, leadDebounce)
  } else {
    // Si ya existe, actualizar processFn (puede haber cambiado)
    leadDebounce.processFn = processFn
  }

  // ─── Cap defensivo de buffer por lead ───
  if (leadDebounce.buffer.length >= MAX_BUFFER_PER_LEAD) {
    console.warn(`[Debounce] Buffer full for lead ${leadId}, dropping oldest message`)
    leadDebounce.buffer.shift()  // Remueve el más viejo
  }

  // ─── Agregar mensaje al buffer ───
  leadDebounce.buffer.push({
    text: text.trim(),
    timestamp: Date.now(),
    metadata
  })

  // ─── KILL-STALE: un mensaje nuevo del lead invalida cualquier respuesta en vuelo ───
  // Se incrementa SIEMPRE que entra un mensaje (incluido el re-encolado por el lock):
  // así el pipeline que esté pensando detecta que su respuesta quedó obsoleta y la
  // descarta antes de enviarla (evita la cascada de 2 mensajes).
  bumpGeneration(leadId)

  // ─── Cancelar timer anterior si existe ───
  if (leadDebounce.timer) {
    clearTimeout(leadDebounce.timer)
  }

  // ─── Crear nuevo timer ───
  leadDebounce.timer = setTimeout(() => {
    flushBuffer(leadId)
  }, DEBOUNCE_WINDOW_MS)

  console.log(`[Debounce] Lead ${leadId} queued msg (buffer: ${leadDebounce.buffer.length}, will process in ${DEBOUNCE_WINDOW_MS}ms)`)

  return {
    queued: true,
    bufferSize: leadDebounce.buffer.length,
    willProcessIn: DEBOUNCE_WINDOW_MS
  }
}

// ════════════════════════════════════════════════════════
// FLUSH — Procesa el buffer cuando expira el timer
// ════════════════════════════════════════════════════════

/**
 * Procesa el buffer del lead: combina todos los mensajes y llama processFn.
 * Llamado automáticamente cuando expira el setTimeout.
 */
async function flushBuffer(leadId) {
  const leadDebounce = debounceState.get(leadId)
  
  if (!leadDebounce || !leadDebounce.buffer.length) {
    debounceState.delete(leadId)
    return
  }

  const { buffer, processFn, firstMessageAt } = leadDebounce
  
  // ─── Limpiar estado ANTES de procesar (idempotencia) ───
  debounceState.delete(leadId)

  // ─── Combinar mensajes ───
  const combinedText = buffer
    .map(msg => msg.text)
    .join('\n')

  const bufferMetadata = {
    messageCount: buffer.length,
    firstMessageAt,
    lastMessageAt: buffer[buffer.length - 1].timestamp,
    timespanMs: Date.now() - firstMessageAt,
    individualMessages: buffer.map(msg => ({
      text: msg.text,
      timestamp: msg.timestamp,
      metadata: msg.metadata
    }))
  }

  console.log(`[Debounce] Flushing lead ${leadId}: ${buffer.length} messages, combined length ${combinedText.length} chars`)

  // ─── Ejecutar processFn con try/catch ───
  try {
    await processFn(combinedText, bufferMetadata)
  } catch (err) {
    console.error(`[Debounce] processFn failed for lead ${leadId}:`, err.message)
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'))
    // NO re-throw: error contenido aquí, no propagar
  }
}

// ════════════════════════════════════════════════════════
// API PÚBLICA — cancelDebounce()
// ════════════════════════════════════════════════════════

/**
 * Cancela el debounce activo de un lead.
 * Llamado cuando vendor humano responde manualmente
 * (NO queremos que bot también responda).
 * 
 * @param {number} leadId
 * @returns {object} { cancelled: boolean, bufferSize: number }
 */
export function cancelDebounce(leadId) {
  const leadDebounce = debounceState.get(leadId)
  
  if (!leadDebounce) {
    return { cancelled: false, bufferSize: 0, reason: 'no_active_debounce' }
  }

  const bufferSize = leadDebounce.buffer.length

  // Cancelar timer
  if (leadDebounce.timer) {
    clearTimeout(leadDebounce.timer)
  }

  // Limpiar estado
  debounceState.delete(leadId)

  console.log(`[Debounce] Cancelled lead ${leadId} (had ${bufferSize} messages buffered)`)

  return {
    cancelled: true,
    bufferSize,
    reason: 'manual_cancel'
  }
}

// ════════════════════════════════════════════════════════
// HELPERS DE DEBUG
// ════════════════════════════════════════════════════════

/**
 * Devuelve info de leads con debounce activo (para /debug)
 */
export function getActiveDebounces() {
  const active = []
  
  for (const [leadId, state] of debounceState.entries()) {
    active.push({
      leadId,
      bufferSize: state.buffer.length,
      firstMessageAt: state.firstMessageAt,
      ageMs: Date.now() - state.firstMessageAt
    })
  }
  
  return {
    total_active: active.length,
    max_active: MAX_ACTIVE_LEADS,
    debounce_window_ms: DEBOUNCE_WINDOW_MS,
    active_leads: active
  }
}

/**
 * Limpia todos los debounces (útil para tests o shutdown)
 */
export function clearAllDebounces() {
  for (const [leadId, state] of debounceState.entries()) {
    if (state.timer) {
      clearTimeout(state.timer)
    }
  }
  debounceState.clear()
  messageGeneration.clear()   // kill-stale: resetear generaciones junto con el debounce
  console.log('[Debounce] All debounces cleared')
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const DEBOUNCE_VERSION = 'v4_killstale_anticascade'
