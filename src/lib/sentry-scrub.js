// src/lib/sentry-scrub.js — Hidata v20 · Observabilidad
//
// SCRUBBING DE PII PARA SENTRY (defensa en profundidad).
//
// POR QUÉ EXISTE:
//   Aunque Sentry corre con sendDefaultPii=false (no captura headers, cookies,
//   IP ni cuerpo de request por su cuenta), NUESTROS mensajes de error,
//   excepciones y breadcrumbs (que incluyen los console.log capturados por la
//   SDK) podrían arrastrar un teléfono o texto del lead. Estas funciones los
//   TACHAN antes de que el evento salga del servidor hacia Sentry.
//   Mismo principio que el blindaje de logs de Render (commit 89e9711): el dato
//   sensible del lead/financiero NUNCA sale a un tercero.
//
// Funciones PURAS (sin efectos secundarios) → testeables sin la SDK ni red.

// Teléfonos: 9+ dígitos consecutivos (con + opcional). Cubre celular peruano
// (9 díg), con código país 51 (11 díg) e internacionales. NO toca IDs cortos
// (lead_id ~4 díg), latencias (~5 díg) ni costos. Sobre-tachar > filtrar PII.
const RE_TEL = /\+?\d{9,}/g

/** Tacha secuencias tipo teléfono dentro de un string. */
export function redactPII(s) {
  if (typeof s !== 'string') return s
  return s.replace(RE_TEL, '[tel-redacted]')
}

/**
 * Tacha un Event de Sentry: mensaje + valores de excepción, y BORRA el cuerpo
 * de la request (los webhooks traen mensajes del lead), cookies, headers y
 * datos de usuario. Se pasa como beforeSend.
 */
export function scrubEvent(event) {
  if (!event) return event
  if (event.message) event.message = redactPII(event.message)
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex?.value) ex.value = redactPII(ex.value)
    }
  }
  if (event.request) {
    delete event.request.data       // cuerpo = payload del webhook = mensajes del lead
    delete event.request.cookies
    delete event.request.headers
    if (event.request.query_string) {
      event.request.query_string = redactPII(event.request.query_string)
    }
  }
  delete event.user                 // sin id/email/ip de usuario
  return event
}

/**
 * Tacha un breadcrumb (incluye los console.log que la SDK captura por default).
 * Se pasa como beforeBreadcrumb.
 */
export function scrubBreadcrumb(b) {
  if (!b) return b
  if (b.message) b.message = redactPII(b.message)
  if (b.data) {
    try { b.data = JSON.parse(redactPII(JSON.stringify(b.data))) } catch { delete b.data }
  }
  return b
}
