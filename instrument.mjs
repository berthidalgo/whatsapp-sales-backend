// instrument.mjs — Hidata v20 · inicialización de Sentry (observabilidad)
//
// Se carga ANTES que todo vía:  node --import ./instrument.mjs src/server.js
// (requisito de ESM: la instrumentación debe correr antes de importar el resto
// de la app, ver docs de Sentry para Fastify/ESM).
//
// INERTE sin SENTRY_DSN: si la cuenta no está creada todavía (o se quiere apagar),
// no se inicializa nada → cero overhead, la SDK queda dormida. Mismo patrón que
// el código de WhatsApp Cloud API: desplegado pero APAGADO hasta enchufar la key.
//
// PII: corre con sendDefaultPii=false + scrubbers propios (src/lib/sentry-scrub)
// → ni teléfonos ni texto del lead salen del servidor. Coherente con el blindaje
// de logs de Render (commit 89e9711).
//
// Sirve IGUAL para sentry.io o GlitchTip (self-hosted): solo cambia el DSN.

import * as Sentry from '@sentry/node'
import { scrubEvent, scrubBreadcrumb } from './src/lib/sentry-scrub.js'

const DSN = process.env.SENTRY_DSN

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.SENTRY_ENV || 'production',
    sendDefaultPii: false,   // explícito: no captura headers/cookies/IP/body
    tracesSampleRate: 0,     // solo errores, sin APM/trazas (cero costo/ruido extra)
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  })
  console.log('[Sentry] inicializado · PII scrubbing ON · entorno=' + (process.env.SENTRY_ENV || 'production'))
} else {
  console.log('[Sentry] SENTRY_DSN no seteado → DESACTIVADO (inerte, sin overhead)')
}
