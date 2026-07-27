// src/lib/assets.js — imágenes estáticas que el bot envía (jul 2026)
// Se leen del disco UNA vez y se cachean en base64 (el archivo vive en apps/api/assets,
// se despliega con el código en Render). El bot colágeno manda la foto de precios en M4.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = join(__dirname, '..', '..', 'assets')
const cache = new Map()

function cargarB64(archivo) {
  if (cache.has(archivo)) return cache.get(archivo)
  let b64 = ''
  try { b64 = readFileSync(join(ASSETS_DIR, archivo)).toString('base64') }
  catch (e) { console.error(`[Assets] no pude leer ${archivo}:`, e.message) }
  cache.set(archivo, b64)
  return b64
}

// ─────────────────────────────────────────────────────────────────────────
// REGISTRO POR TENANT (fix pre-producción jul 2026)
//
// ANTES el registro era PLANO: la clave `precios` apuntaba a la foto de BIOAYUR
// para todo el mundo, y `getImagen()` no sabía de qué cliente era el turno. El
// cerebro pide la imagen por NOMBRE (enviar_imagen: "precios"), así que en cuanto
// un segundo cliente usara esa misma clave —y va a usarla, porque el vertical de
// colágeno es la plantilla que se copia para los clientes nuevos— sus leads
// habrían recibido LA LISTA DE PRECIOS DE OTRA EMPRESA por WhatsApp.
//
// No era teórico: bastaba un vertical nuevo con `enviar_imagen: "precios"`.
// Ahora la clave se resuelve DENTRO del tenant. Dos clientes pueden llamar
// "precios" a su foto sin pisarse.
//
// FAIL-CLOSED: sin tenant, o si el tenant no tiene esa clave, se devuelve null y
// NO se manda nada. Mandar la imagen equivocada es peor que no mandar ninguna.
// ─────────────────────────────────────────────────────────────────────────
const REGISTRO_POR_TENANT = {
  bioayur: {
    precios: { archivo: 'precios-bioayur.png', mimetype: 'image/png', fileName: 'BIOAYUR-precios.png' }
  }
  // Cliente nuevo → agregar su bloque aquí con SUS archivos. Nunca reutilizar el
  // archivo de otro tenant, aunque la clave se llame igual.
}

/**
 * Imagen que el cerebro pidió adjuntar, resuelta DENTRO del tenant.
 * @param {string} clave     - lo que el cerebro puso en `enviar_imagen` (ej. "precios")
 * @param {string} tenantId  - dueño del turno. Sin él no se sirve nada.
 * @returns {{base64,mimetype,fileName}|null}
 */
export function getImagen(clave, tenantId) {
  if (!clave || !tenantId) return null
  const delTenant = REGISTRO_POR_TENANT[tenantId]
  if (!delTenant) return null
  const def = delTenant[clave]
  if (!def) return null
  const base64 = cargarB64(def.archivo)
  if (!base64) return null
  return { base64, mimetype: def.mimetype, fileName: def.fileName }
}

export const ASSETS_VERSION = 'v2_por_tenant'
