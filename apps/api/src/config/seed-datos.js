import { exigirObjetoSeguro, validarCampaignConfig, validarTriggers } from './campaign-schema.js'
export const normalizarTelefono = t => String(t || '').replace(/\D/g,'')
const objeto = x => !!x && typeof x === 'object' && !Array.isArray(x)
const texto = x => typeof x === 'string' && !!x.trim()
export function validarDatos(d) {
  if (!objeto(d)) return ['el JSON debe ser un objeto']
  try { exigirObjetoSeguro(d) } catch(e) { return [e.message] }
  const errores=[], t=d.tenant || {}, telefonos=new Set(), slugs=new Set()
  if (!texto(t.tenantId) || !/^[a-zA-Z0-9_-]+$/.test(t.tenantId)) errores.push('tenant.tenantId: requerido')
  if (!texto(t.displayName)) errores.push('tenant.displayName: requerido')
  if (t.numVendedoresPagados !== undefined && (!Number.isInteger(t.numVendedoresPagados) || t.numVendedoresPagados < 1)) errores.push('tenant.numVendedoresPagados: entero positivo')
  if (!Array.isArray(d.vendors) || !d.vendors.length) errores.push('vendors: lista no vacía requerida')
  for (const [i,v] of (Array.isArray(d.vendors) ? d.vendors : []).entries()) {
    if (!objeto(v)) { errores.push('vendors['+i+']: objeto requerido'); continue }
    const tel=normalizarTelefono(v.telefono)
    if (!texto(v.nombre) || !/^\d{9,15}$/.test(tel)) errores.push('vendors['+i+']: nombre y teléfono válidos requeridos')
    if (telefonos.has(tel)) errores.push('vendors['+i+']: teléfono duplicado')
    telefonos.add(tel)
    if (v.role !== undefined && !['ADMIN','SUPERVISOR','VENDOR'].includes(v.role)) errores.push('vendors['+i+'].role: inválido')
  }
  if (!Array.isArray(d.campaigns) || !d.campaigns.length) errores.push('campaigns: lista no vacía requerida')
  for (const [i,c] of (Array.isArray(d.campaigns) ? d.campaigns : []).entries()) {
    const p='campaigns['+i+']'
    if (!objeto(c)) { errores.push(p+': objeto requerido'); continue }
    if (!texto(c.slug) || !texto(c.nombre)) errores.push(p+': slug y nombre requeridos')
    const slug=String(c.slug || '').toUpperCase()
    if (slugs.has(slug)) errores.push(p+': slug duplicado'); slugs.add(slug)
    if (!telefonos.has(normalizarTelefono(c.vendorTelefono))) errores.push(p+'.vendorTelefono: no está en vendors')
    if (c.activa !== undefined && typeof c.activa !== 'boolean') errores.push(p+'.activa: booleano requerido')
    if (c.activa !== false || c.config != null) {
      const vc=validarCampaignConfig(c.config,{tenantId:t.tenantId})
      errores.push(...vc.errores.map(e=>p+'.config: '+e))
    }
    const vt=validarTriggers(c.triggers ?? [],{permitirVacios:c.activa===false || c.config?.atribucion?.esCampanaDefault===true})
    errores.push(...vt.errores.map(e=>p+': '+e))
    if (c.steps !== undefined && !Array.isArray(c.steps)) errores.push(p+'.steps: lista requerida')
    for (const [j,s] of (Array.isArray(c.steps) ? c.steps : []).entries()) {
      if (!objeto(s) || !['MSG','NOTIFY','FOLLOWUP'].includes(s.tipo) || !texto(s.mensaje)) errores.push(p+'.steps['+j+']: tipo y mensaje válidos requeridos')
      if (s?.followupHrs !== undefined && (!Number.isFinite(s.followupHrs) || s.followupHrs <= 0)) errores.push(p+'.steps['+j+'].followupHrs: número positivo')
    }
    if (c.configFuente !== undefined && !['seed','dashboard'].includes(c.configFuente)) errores.push(p+'.configFuente: seed o dashboard')
  }
  return errores
}
