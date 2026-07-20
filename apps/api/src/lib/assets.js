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

// Registro de imágenes que el cerebro puede pedir vía el campo `enviar_imagen`.
const REGISTRO = {
  precios: { archivo: 'precios-bioayur.png', mimetype: 'image/png', fileName: 'BIOAYUR-precios.png' }
}

// Devuelve { base64, mimetype, fileName } para una clave, o null si no existe / vacía.
export function getImagen(clave) {
  const def = REGISTRO[clave]
  if (!def) return null
  const base64 = cargarB64(def.archivo)
  if (!base64) return null
  return { base64, mimetype: def.mimetype, fileName: def.fileName }
}

export const ASSETS_VERSION = 'v1_precios'
