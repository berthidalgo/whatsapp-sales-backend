// src/webhook/idempotency.js — Hidata v20 Día 7
//
// IDEMPOTENCY MANAGER
//
// Previene procesar el mismo mensaje de WhatsApp más de una vez.
// Evolution puede enviar webhooks duplicados (retries, conexión inestable).
// Sin esto, el bot respondería 2-3 veces al mismo mensaje.
//
// Implementación: Map en memoria con TTL automático.
//
// Funcionamiento:
//   - markAsProcessed(messageId) → registra mensaje
//   - isAlreadyProcessed(messageId) → consulta si ya fue procesado
//   - Cleanup automático cada 1 minuto (mensajes viejos eliminados)
//
// Por qué Map en memoria y no Redis (Día 7):
//   - Render free tier = 1 sola instancia (sin necesidad de compartir)
//   - Cero latencia adicional
//   - Sin dependencia externa
//   - Día 8+ migramos a Redis si escalamos a múltiples instancias

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
const MESSAGE_TTL_MS = 5 * 60 * 1000          // 5 minutos
const CLEANUP_INTERVAL_MS = 60 * 1000          // Limpia cada 1 minuto
const MAX_ENTRIES = 10000                      // Cap para evitar memory leak

// ════════════════════════════════════════════════════════
// ESTADO INTERNO (singleton del proceso)
// ════════════════════════════════════════════════════════
const processedMessages = new Map()
let cleanupTimer = null

// ════════════════════════════════════════════════════════
// API PÚBLICA
// ════════════════════════════════════════════════════════

/**
 * Verifica si un mensaje ya fue procesado.
 * 
 * @param {string} messageId - ID único del mensaje (de Evolution)
 * @returns {boolean} true si ya fue procesado, false si es nuevo
 */
export function isAlreadyProcessed(messageId) {
  if (!messageId) return false
  
  const entry = processedMessages.get(messageId)
  if (!entry) return false
  
  // Verificar TTL inline (por si cleanup automático no corrió aún)
  const age = Date.now() - entry.timestamp
  if (age > MESSAGE_TTL_MS) {
    processedMessages.delete(messageId)
    return false
  }
  
  return true
}

/**
 * Marca un mensaje como procesado.
 * 
 * @param {string} messageId - ID único del mensaje
 * @param {object} metadata - Metadata opcional para debug
 */
export function markAsProcessed(messageId, metadata = {}) {
  if (!messageId) return
  
  // Cap defensivo: si llegamos al límite, hacer cleanup forzado
  if (processedMessages.size >= MAX_ENTRIES) {
    console.warn(`[Idempotency] Reached MAX_ENTRIES (${MAX_ENTRIES}), forcing cleanup`)
    cleanup()
  }
  
  processedMessages.set(messageId, {
    timestamp: Date.now(),
    metadata
  })
  
  // Iniciar cleanup automático si no está corriendo
  startCleanupTimer()
}

/**
 * Helper combinado: verifica + marca en una operación atómica.
 * Devuelve true si era nuevo (procesar), false si ya fue procesado (skip).
 * 
 * @param {string} messageId
 * @param {object} metadata
 * @returns {boolean} true = procesar, false = skip
 */
export function checkAndMark(messageId, metadata = {}) {
  if (!messageId) return true  // Sin ID, procesar por defecto
  
  if (isAlreadyProcessed(messageId)) {
    return false  // Skip
  }
  
  markAsProcessed(messageId, metadata)
  return true  // Procesar
}

// ════════════════════════════════════════════════════════
// CLEANUP AUTOMÁTICO
// ════════════════════════════════════════════════════════

/**
 * Limpia entradas expiradas del Map.
 * Llamado automáticamente cada CLEANUP_INTERVAL_MS.
 */
function cleanup() {
  const now = Date.now()
  let removed = 0
  
  for (const [messageId, entry] of processedMessages.entries()) {
    const age = now - entry.timestamp
    if (age > MESSAGE_TTL_MS) {
      processedMessages.delete(messageId)
      removed++
    }
  }
  
  if (removed > 0) {
    console.log(`[Idempotency] Cleanup: removed ${removed} expired entries (${processedMessages.size} remaining)`)
  }
}

/**
 * Inicia el timer de cleanup si no está corriendo.
 * Idempotente: múltiples calls no crean múltiples timers.
 */
function startCleanupTimer() {
  if (cleanupTimer) return
  
  cleanupTimer = setInterval(() => {
    cleanup()
  }, CLEANUP_INTERVAL_MS)
  
  // Permitir que el proceso termine si solo queda este timer
  if (cleanupTimer.unref) {
    cleanupTimer.unref()
  }
}

// ════════════════════════════════════════════════════════
// HELPERS DE DEBUG
// ════════════════════════════════════════════════════════

/**
 * Devuelve stats del idempotency manager (para /debug/health o métricas)
 */
export function getIdempotencyStats() {
  return {
    total_entries: processedMessages.size,
    max_entries: MAX_ENTRIES,
    ttl_ms: MESSAGE_TTL_MS,
    cleanup_interval_ms: CLEANUP_INTERVAL_MS,
    oldest_entry_age_ms: getOldestEntryAge(),
    cleanup_active: cleanupTimer !== null
  }
}

/**
 * Devuelve la edad de la entrada más vieja (para detectar leaks)
 */
function getOldestEntryAge() {
  if (processedMessages.size === 0) return null
  
  const now = Date.now()
  let oldest = 0
  
  for (const entry of processedMessages.values()) {
    const age = now - entry.timestamp
    if (age > oldest) oldest = age
  }
  
  return oldest
}

/**
 * Limpia todo (útil para tests)
 */
export function clearAll() {
  processedMessages.clear()
  console.log('[Idempotency] All entries cleared')
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const IDEMPOTENCY_VERSION = 'v1_day7_inmemory_ttl'