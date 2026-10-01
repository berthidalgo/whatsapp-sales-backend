import { readFileSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archivoPermitido, registroImagenes } from '../config/imagenes.js'
const carpeta = fileURLToPath(new URL('../../assets/',import.meta.url))
function dentro(base, archivo) { const r = relative(base,archivo); return r && !r.startsWith('..') && !isAbsolute(r) }
function mimeReal(b) {
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (b[0]===255 && b[1]===216 && b[2]===255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(b.subarray(0,6).toString())) return 'image/gif'
  if (b.subarray(0,4).toString()==='RIFF' && b.subarray(8,12).toString()==='WEBP') return 'image/webp'
  return null
}
export function getImagen(clave, tenantId, imagenesConfig = null) {
  if (!clave || !tenantId) return null
  const def = imagenesConfig !== null ? (Object.hasOwn(imagenesConfig,clave) ? imagenesConfig[clave] : null) : registroImagenes()[tenantId]?.[clave]
  if (!def || !archivoPermitido(def.archivo,tenantId)) return null
  try {
    const base = realpathSync(carpeta), archivo = realpathSync(resolve(base,def.archivo))
    if (!dentro(base,archivo)) return null
    // Real path also must stay in the tenant namespace (symlinks cannot change owner).
    if (!archivoPermitido(relative(base,archivo).replaceAll('\\','/'),tenantId)) return null
    const bytes = readFileSync(archivo), mimetype = mimeReal(bytes)
    if (!mimetype || (def.mimetype && mimetype !== def.mimetype)) return null
    return { base64: bytes.toString('base64'), mimetype, fileName: basename(def.fileName || def.archivo) }
  } catch { return null }
}
export const ASSETS_VERSION = 'v4_tenant_y_firma'
