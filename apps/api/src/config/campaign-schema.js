import { montosMonetarios } from './dinero.js'
import { archivoPermitido } from './imagenes.js'

// src/config/campaign-schema.js — CONTRATO VALIDADO de campaigns.config
//
// La ficha comercial (precios, oferta, identidad del agente, triggers de la
// campaña) vive en BD como JSON. Sin contrato, cualquier PUT la dejaba en un
// estado que el cerebro no entiende: precio sin texto, monto que no aparece en
// el texto, ficha sin identidad, o borrada por accidente al omitir un campo.
//
// Este módulo es PURO (sin red ni BD): valida y normaliza. Lo usan:
//   · PUT /v2/agent-config      (ficha editada desde el CRM)
//   · POST/PUT /campaigns       (alta y edición de campañas)
//   · scripts/seed-generico.js  (altas por JSON, Etapa 2 sin editor)
//
// Reglas (fail-closed con mensajes accionables):
//   · vertical: si viene, debe ser uno conocido.
//   · agente: nombre + empresa obligatorios (el bot jamás habla sin identidad;
//     el fallback genérico solo cubre lecturas de campañas legacy, nunca
//     escrituras nuevas).
//   · factSheet.precio: textoExacto obligatorio con moneda y cifras; si trae
//     monto, sus dígitos deben aparecer en el texto (coherencia que también
//     exige el guardrail de precio fantasma en runtime).
//   · ofertaHoy: si viene, debe traer cifra + moneda (una "promo" sin precio
//     es el invento que el guardrail tendría que neutralizar después).
//   · atribucion.esCampanaDefault=true exige mensajeDescubrimiento.
//   · Omitir una sección ≠ borrarla: el merge es por sección en el llamador;
//     aquí solo se valida el resultado fusionado.

export const VERTICALES = Object.freeze(['exportacion', 'colageno', 'tienda'])

export const LIMITES = Object.freeze({
  identidad: 120,     // agente.nombre / empresa / nombreProducto / rol
  precioTexto: 2000,  // factSheet.precio.textoExacto
  fichaTexto: 2000,   // propuestaValor, publicoObjetivo, ofertaHoy
  itemLista: 500,     // cada incluye / reglaOro / faq
  descubrimiento: 1000,
  followup: 500,
  trigger: 120
})

// Monedas que el negocio usa en texto libre. Sin marcador de moneda, una cifra
// es cantidad de cualquier cosa (sesiones, envases, meses) y NO un precio.
const tienePrecio = texto => montosMonetarios(texto).length > 0
const RX_CIFRA = /\d/

function esObjeto(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
}

function textoOk(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
}

// "S/ 1,500" contiene a 1500 · "S/ 124.50" contiene a 124.5 · "S/. 139" a 139.
function digitosIncluidos(texto, monto) {
  return montosMonetarios(texto).some(n => Math.abs(n - monto) < 0.001)
}

export function normalizarTrigger(texto) {
  return (typeof texto === 'string' ? texto : '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function validarTrigger(texto) {
  if (typeof texto !== 'string') return { ok: false, error: 'debe ser texto', valor: '' }
  const valor = normalizarTrigger(texto)
  if (valor.length < 2) return { ok: false, error: 'trigger vacío o de 1 letra (tras normalizar)', valor }
  if (valor.length > LIMITES.trigger) return { ok: false, error: `trigger de más de ${LIMITES.trigger} caracteres`, valor }
  return { ok: true, valor }
}

export function validarTriggers(lista, { permitirVacios = false } = {}) {
  const errores = []
  if (!Array.isArray(lista) || (!permitirVacios && lista.length === 0)) {
    return { ok: false, errores: ['triggers: se exige al menos 1 (una campaña sin trigger nunca dispara)'], valores: [] }
  }
  const valores = []
  const vistos = new Set()
  lista.forEach((t, i) => {
    const r = validarTrigger(t)
    if (!r.ok) { errores.push(`triggers[${i}]: ${r.error}`); return }
    if (vistos.has(r.valor)) { errores.push(`triggers[${i}]: duplicado de "${r.valor}"`); return }
    vistos.add(r.valor)
    valores.push(r.valor)
  })
  return { ok: errores.length === 0, errores, valores }
}

function validarAgente(agente, errores) {
  if (agente === undefined) { errores.push('agente: requerido (nombre y empresa del negocio)'); return }
  if (!esObjeto(agente)) { errores.push('agente: debe ser un objeto'); return }
  if (!textoOk(agente.nombre, LIMITES.identidad)) errores.push('agente.nombre: requerido (quién atiende el chat)')
  if (!textoOk(agente.empresa, LIMITES.identidad)) errores.push('agente.empresa: requerido (el negocio que vende)')
  for (const k of ['nombreProducto', 'rol']) {
    if (agente[k] !== undefined && !textoOk(agente[k], LIMITES.identidad)) {
      errores.push(`agente.${k}: si viene, texto no vacío de máx ${LIMITES.identidad}`)
    }
  }
}

function validarPrecio(precio, errores) {
  if (precio === undefined) return
  if (!esObjeto(precio)) { errores.push('factSheet.precio: debe ser un objeto'); return }
  if (!textoOk(precio.textoExacto, LIMITES.precioTexto)) {
    errores.push('factSheet.precio.textoExacto: requerido (el texto que lista los packs, tal cual lo ve el lead)')
  } else {
    if (!tienePrecio(precio.textoExacto)) errores.push('factSheet.precio.textoExacto: sin marcador de moneda (S/, soles, $…) — una cifra sin moneda no es un precio')
    if (!RX_CIFRA.test(precio.textoExacto)) errores.push('factSheet.precio.textoExacto: sin cifras — el guardrail no tendría qué validar')
  }
  if (precio.monto !== undefined && precio.monto !== null) {
    if (typeof precio.monto !== 'number' || !Number.isFinite(precio.monto) || precio.monto <= 0) {
      errores.push('factSheet.precio.monto: si viene, número finito mayor a 0')
    } else if (textoOk(precio.textoExacto, LIMITES.precioTexto) && !digitosIncluidos(precio.textoExacto, precio.monto)) {
      errores.push(`factSheet.precio.monto: ${precio.monto} no aparece en textoExacto — el guardrail marcaría el precio real como inventado`)
    }
  }
  if (precio.moneda !== undefined && !textoOk(precio.moneda, 10)) {
    errores.push('factSheet.precio.moneda: si viene, texto no vacío (ej. "S/")')
  }
}

function validarListaCadenas(valor, campo, errores, { obligatoria = false } = {}) {
  if (valor === undefined) {
    if (obligatoria) errores.push(`${campo}: requerido`)
    return
  }
  if (!Array.isArray(valor) || valor.length === 0) { errores.push(`${campo}: si viene, lista no vacía`); return }
  valor.forEach((item, i) => {
    if (!textoOk(item, LIMITES.itemLista)) errores.push(`${campo}[${i}]: texto no vacío de máx ${LIMITES.itemLista}`)
  })
}

function validarFactSheet(fs, errores, tenantId) {
  if (fs === undefined) { errores.push('factSheet: requerido'); return }
  if (!esObjeto(fs)) { errores.push('factSheet: debe ser un objeto'); return }
  validarPrecio(fs.precio, errores)
  if (fs.ofertaHoy !== undefined && fs.ofertaHoy !== null && String(fs.ofertaHoy).trim() !== '') {
    if (!textoOk(fs.ofertaHoy, LIMITES.fichaTexto)) {
      errores.push(`factSheet.ofertaHoy: texto no vacío de máx ${LIMITES.fichaTexto}`)
    } else {
      if (!RX_CIFRA.test(fs.ofertaHoy)) errores.push('factSheet.ofertaHoy: sin cifras — una promo sin precio es un invento en potencia')
      if (!tienePrecio(fs.ofertaHoy)) errores.push('factSheet.ofertaHoy: sin marcador de moneda (S/, soles, $…)')
    }
  }
  for (const k of ['propuestaValor', 'publicoObjetivo']) {
    if (fs[k] !== undefined && !textoOk(fs[k], LIMITES.fichaTexto)) {
      errores.push(`factSheet.${k}: si viene, texto no vacío de máx ${LIMITES.fichaTexto}`)
    }
  }
  validarListaCadenas(fs.incluye, 'factSheet.incluye', errores)
  validarListaCadenas(fs.reglasOro, 'factSheet.reglasOro', errores)
  validarListaCadenas(fs.metodosPago, 'factSheet.metodosPago', errores)
  validarListaCadenas(fs.pildorasValor, 'factSheet.pildorasValor', errores)
  if (fs.testimonios !== undefined) {
    if (!Array.isArray(fs.testimonios)) { errores.push('factSheet.testimonios: si viene, lista (vacía = sin testimonios, jamás inventados)') }
    else fs.testimonios.forEach((t, i) => {
      if (!esObjeto(t) || !textoOk(t.texto, LIMITES.fichaTexto)) errores.push(`factSheet.testimonios[${i}].texto: requerido`)
      if (t && t.dolor !== undefined && !textoOk(t.dolor, 40)) errores.push(`factSheet.testimonios[${i}].dolor: si viene, texto corto`)
    })
  }
  if (fs.imagenes !== undefined) {
    if (!esObjeto(fs.imagenes)) { errores.push('factSheet.imagenes: si viene, objeto {clave: {storageKey|archivo, mimetype}}') }
    else for (const [clave, def] of Object.entries(fs.imagenes)) {
      if (!esObjeto(def) || !archivoPermitido(def.archivo, tenantId)) {
        errores.push(`factSheet.imagenes.${clave}: exige archivo local registrado para el tenant o dentro de su carpeta`)
      }
      if (esObjeto(def) && def.mimetype !== undefined && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(def.mimetype)) {
        errores.push(`factSheet.imagenes.${clave}.mimetype: tipo de imagen no permitido`)
      }
    }
  }
}

function validarAtribucion(atribucion, errores) {
  if (atribucion === undefined) return
  if (!esObjeto(atribucion)) { errores.push('atribucion: debe ser un objeto'); return }
  if (atribucion.esCampanaDefault !== undefined && typeof atribucion.esCampanaDefault !== 'boolean') {
    errores.push('atribucion.esCampanaDefault: si viene, booleano')
  }
  if (atribucion.esCampanaDefault === true && !textoOk(atribucion.mensajeDescubrimiento, LIMITES.descubrimiento)) {
    errores.push('atribucion.mensajeDescubrimiento: requerido cuando la campaña es la default (es lo primero que lee el lead perdido)')
  }
}

function validarFollowups(followups, errores) {
  if (followups === undefined) return
  if (!esObjeto(followups)) { errores.push('followups: debe ser un objeto'); return }
  for (const k of ['followup_2h', 'followup_24h', 'compromiso']) {
    if (followups[k] !== undefined && !textoOk(followups[k], LIMITES.followup)) {
      errores.push(`followups.${k}: si viene, texto no vacío de máx ${LIMITES.followup} (puede usar {{nombre}} y {{producto}})`)
    }
  }
}

// Valida el config FUSIONADO (tras el merge por sección). Devuelve la lista de
// problemas; vacía = listo para guardar.
export function validarCampaignConfig(config, { tenantId } = {}) {
  const errores = []
  if (!esObjeto(config)) return { ok: false, errores: ['config: debe ser un objeto'] }
  const peligro = buscarClavePeligrosa(config)
  if (peligro) return { ok: false, errores: [`config rechazada: clave o estructura no permitida "${peligro}"`] }
  if (config.vertical !== undefined && !VERTICALES.includes(config.vertical)) {
    errores.push(`vertical: "${config.vertical}" desconocido (usa ${VERTICALES.join('|')})`)
  }
  validarAgente(config.agente, errores)
  validarFactSheet(config.factSheet, errores, tenantId)
  validarAtribucion(config.atribucion, errores)
  validarFollowups(config.followups, errores)
  return { ok: errores.length === 0, errores }
}

// Fusiona el config guardado con un parche parcial, POR SECCIÓN (omitir una
// sección la conserva; para vaciarla se manda null explícito). Es lo que evita
// el borrado accidental de la ficha desde el CRM.
export function fusionarConfig(actual, parche) {
  exigirObjetoSeguro(actual)
  exigirObjetoSeguro(parche)
  const base = esObjeto(actual) ? actual : {}
  const p = esObjeto(parche) ? parche : {}
  const out = { ...base }
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue
    if (v === null) delete out[k]
    else out[k] = esObjeto(v) ? fusionarConfig(base[k], v) : v
  }
  return out
}

export function exigirObjetoSeguro(valor) {
  const peligro = buscarClavePeligrosa(valor)
  if (peligro) throw new TypeError(`config rechazada: clave o estructura no permitida "${peligro}"`)
}

export function contieneBorrado(parche, actual) {
  if (parche === null) return actual !== null && actual !== undefined
  if (!esObjeto(parche)) return false
  return Object.entries(parche).some(([k, v]) => v === null
    ? actual?.[k] !== null && actual?.[k] !== undefined
    : esObjeto(v) && contieneBorrado(v, actual?.[k]))
}

// ── Claves peligrosas (prototype pollution) ───────────────────────────────
// Todo config debe ser JSON plano y sin claves de prototipo antes del merge
// recursivo. Se aplica también a seeds y scripts, además de las rutas HTTP:
//   1. fusionarConfig las rechaza (defensa para TODO llamador: API, seeds, scripts);
//   2. buscarClavePeligrosa + 400 en las rutas (el operador ve el rechazo, no un
//      guardado a medias con una clave rara).
const CLAVES_PELIGROSAS = new Set(['__proto__', 'prototype', 'constructor'])

// Recorre el objeto y devuelve la ruta de la primera clave peligrosa, o null.
export function buscarClavePeligrosa(valor, ruta = '', profundidad = 0) {
  if (valor === null || typeof valor !== 'object') return null
  if (!esObjeto(valor) && !Array.isArray(valor)) return `${ruta || 'config'}: objeto con prototipo no permitido`
  if (profundidad > 12) return `${ruta || 'config'}: demasiado anidado`
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i++) {
      const hit = buscarClavePeligrosa(valor[i], `${ruta}[${i}]`, profundidad + 1)
      if (hit) return hit
    }
    return null
  }
  for (const [k, v] of Object.entries(valor)) {
    const aqui = ruta ? `${ruta}.${k}` : k
    if (CLAVES_PELIGROSAS.has(k)) return aqui
    const hit = buscarClavePeligrosa(v, aqui, profundidad + 1)
    if (hit) return hit
  }
  return null
}

// Límite de tamaño del guion (flow_steps): un operador pegando un guion enorme
// no es un caso de uso; 50 pasos con 2 000 caracteres cada uno es holgado.
export const LIMITES_FLOW = Object.freeze({ pasos: 50, mensaje: 2000 })

// Valida `steps` (FlowStep: tipo + mensaje; followupHrs opcional > 0).
export function validarSteps(steps) {
  const errores = []
  if (!Array.isArray(steps)) return { ok: false, errores: ['steps: debe ser un array'], valores: [] }
  if (steps.length > LIMITES_FLOW.pasos) errores.push(`steps: máx ${LIMITES_FLOW.pasos} pasos`)
  const valores = []
  steps.forEach((s, i) => {
    if (!esObjeto(s)) { errores.push(`steps[${i}]: debe ser un objeto`); return }
    const tipo = String(s.tipo || 'MSG').toUpperCase()
    if (!['MSG', 'FOLLOWUP', 'NOTIFY'].includes(tipo)) {
      errores.push(`steps[${i}].tipo: "${s.tipo}" desconocido (usa MSG | FOLLOWUP | NOTIFY)`)
    }
    if (!textoOk(s.mensaje, LIMITES_FLOW.mensaje)) {
      errores.push(`steps[${i}].mensaje: requerido, máx ${LIMITES_FLOW.mensaje}`)
    }
    const fh = s.followupHrs
    if (fh !== undefined && fh !== null && (!Number.isInteger(Number(fh)) || Number(fh) <= 0)) {
      errores.push(`steps[${i}].followupHrs: entero positivo si viene`)
    }
    valores.push({
      tipo, mensaje: String(s.mensaje || '').trim(),
      followupHrs: fh === undefined || fh === null ? null : Number(fh),
    })
  })
  return { ok: errores.length === 0, errores, valores }
}

// ── Gate de ACTIVACIÓN ───────────────────────────────────────────────────
// El borrador permite guardar la ficha incompleta (estado de negocio válido: una
// campaña pendiente de completar), pero el paso a `activa=true` NO puede saltarse
// el contrato: esa transición es la que pone al bot a hablar con clientes reales.
// El gate vive en la transición y no solo en el alta — si solo se validara al crear,
// un borrador con precio incoherente podría activarse después, y el loader mete
// `precio.textoExacto` literal en el prompt sin re-chequeo en runtime.
export function validarParaActivar({ config, triggerCount = 0, steps = [], tenantId }) {
  const errores = []
  if (!esObjeto(config)) {
    errores.push('config: una campaña activa necesita ficha (config)')
  } else {
    const vc = validarCampaignConfig(config, { tenantId })
    if (!vc.ok) errores.push(...vc.errores)
  }
  if (triggerCount < 1 && config?.atribucion?.esCampanaDefault !== true) errores.push('triggers: se exige al menos 1 (una campaña sin trigger nunca dispara)')
  if (Array.isArray(steps) && steps.length) {
    const vs = validarSteps(steps)
    if (!vs.ok) errores.push(...vs.errores)
  }
  return { ok: errores.length === 0, errores }
}
