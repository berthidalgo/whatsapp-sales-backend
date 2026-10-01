// Permite los servidores simulados locales; falla antes de cualquier API externa.
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
const locales = new Set(['localhost','127.0.0.1','::1'])
function comprobar(input) {
  let host
  if (typeof input === 'string' || input instanceof URL) host = new URL(input).hostname
  else if (input?.url) host = new URL(input.url).hostname
  else host = input?.hostname || input?.host || 'localhost'
  host = String(host).replace(/^\[|\]$/g,'').replace(/^(127\.0\.0\.1|localhost):\d+$/, '$1')
  if (!locales.has(host)) throw new Error(`Prueba offline: red externa bloqueada (${host})`)
}
const fetchReal = globalThis.fetch
if (fetchReal) globalThis.fetch = (input,...args) => { comprobar(input); return fetchReal(input,...args) }
for (const mod of [http,https]) for (const nombre of ['request','get']) {
  const real=mod[nombre]
  mod[nombre]=function(input,...args){ comprobar(input); return real.call(this,input,...args) }
}
syncBuiltinESMExports()