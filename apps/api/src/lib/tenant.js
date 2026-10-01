import { readFileSync, readdirSync } from 'node:fs'
import { runtime } from '../config/runtime.js'
const carpeta = new URL('../../data/tenants/',import.meta.url)
const verticales = new Map()
for (const nombre of readdirSync(carpeta).filter(n => n.endsWith('.json'))) {
  const dato = JSON.parse(readFileSync(new URL(nombre,carpeta),'utf8'))
  const defaults = dato.campaigns.filter(c => c.config?.atribucion?.esCampanaDefault)
  const vertical = defaults[0]?.config?.vertical || dato.campaigns[0]?.config?.vertical
  if (dato.tenant?.tenantId && vertical) verticales.set(dato.tenant.tenantId,vertical)
}
export const ACTIVE_TENANT = process.env.ACTIVE_TENANT || runtime.activeTenant
export function verticalPorTenant(tenantId) { return verticales.get(tenantId) || runtime.defaultVertical }
export const TENANT_VERSION = 'v2_registro_datos'
