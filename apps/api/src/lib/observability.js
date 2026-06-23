// src/lib/observability.js — Hidata v20 · Observabilidad
//
// reportError(): manda una excepción a Sentry CON contexto seguro (sin PII).
//
// POR QUÉ: lo que Sentry captura solo (crashes no atrapados + errores de rutas
// Fastify) NO incluye los errores que nosotros ATRAPAMOS con try/catch +
// console.error (la mayoría). Ahí viven los que muerden en silencio (el crash
// del foreign key, una notificación al vendedor que falla, etc.). Sembrando
// reportError() en esos catch, esos errores SÍ llegan a la red.
//
// SEGURO: si Sentry no está inicializado (sin SENTRY_DSN — local o apagado),
// captureException es no-op → cero efecto. El scrubber de instrument.mjs tacha
// cualquier teléfono que se cuele en el mensaje como última red.
//
// REGLA DE PII: pasar SOLO metadata NO sensible (leadId numérico, módulo, stage,
// flags). JAMÁS el texto del mensaje del lead ni su teléfono.

import * as Sentry from '@sentry/node'

/**
 * Reporta un error a Sentry con contexto seguro. Nunca lanza.
 * @param {Error} err
 * @param {object} ctx - { module, leadId, ...extra }  (solo metadata no-PII)
 */
export function reportError(err, { module = 'unknown', leadId = null, ...extra } = {}) {
  try {
    Sentry.captureException(err, {
      tags: { module },
      extra: { leadId, ...extra }
    })
  } catch {
    // El reporte JAMÁS debe tumbar el flujo. Si Sentry falla, silencio.
  }
}
