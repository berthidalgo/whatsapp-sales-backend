import { readFileSync } from 'node:fs'
const registro = JSON.parse(readFileSync(new URL('../../data/assets-legacy.json',import.meta.url),'utf8'))
export function archivoPermitido(archivo, tenantId) {
  if (typeof archivo !== 'string' || !archivo || archivo.length > 300 || /[\\:\x00]/.test(archivo) || archivo.startsWith('/') || archivo.split('/').some(p => !p || p === '.' || p === '..')) return false
  const partes = archivo.split('/')
  if (partes.length > 1) return !!tenantId && partes[0] === tenantId && /^[a-zA-Z0-9_-]+$/.test(tenantId)
  const duenos = Object.entries(registro).filter(([,defs]) => defs && typeof defs === 'object' && Object.values(defs).some(d => d?.archivo === archivo)).map(([id]) => id)
  return tenantId ? duenos.includes(tenantId) : duenos.length === 1
}
export function registroImagenes() { return registro }
