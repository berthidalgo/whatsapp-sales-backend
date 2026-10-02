// src/whatsapp/cloud/plantillas-catalogo.js — las plantillas que el bot NECESITA en Meta (sep 2026)
//
// POR QUÉ EXISTE: con la API oficial, escribirle a un cliente FUERA de la ventana de 24 h
// solo se puede con una plantilla aprobada por Meta. El código ya las usa (followups,
// compromisos, reapertura desde la bandeja, aviso al vendedor) y las busca por nombre en
// variables de entorno (CLOUD_TEMPLATE_*), pero alguien tenía que crearlas a mano en el
// panel de Meta, con el orden exacto de variables que el código espera. Aquí quedan
// escritas UNA vez, junto al código que las llena; scripts/meta-plantillas.js las crea
// (o las revisa) por la API en cualquier cuenta de WhatsApp (WABA), la de Hidata o la de
// un cliente. Y como el texto vive aquí, el historial guarda lo que el cliente REALMENTE
// recibió (textoDePlantilla), no un borrador.
//
// REGLAS DE META que se validan aquí (si no, Meta las rechaza y se pierde el día):
//   · nombre: minúsculas, números y guion bajo.
//   · cuerpo: máx. 1024 caracteres; NO puede empezar ni terminar con una variable.
//   · variables {{1}}, {{2}}… correlativas, y un ejemplo por cada una (Meta lo exige).
//
// CATEGORÍA (cambia el precio Y la entrega):
//   · utility   — ligada a algo que el cliente ya pidió o acordó, SIN intención comercial
//                 (confirmar un pedido, recordar una cita). Más barata, gratis dentro de la
//                 ventana, y sin el tope de marketing por usuario.
//   · marketing — promocional o de re-enganche ("¿sigues interesado?"). Siempre se cobra y
//                 Meta limita cuántas recibe cada persona de todos los negocios: por encima
//                 del tope NO se entrega (error 131049, llega por webhook), y el cliente
//                 puede darse de baja del marketing de este negocio (131050).
//   Desde el 9-abr-2025, si pides utility y el texto es promocional, Meta la APRUEBA como
//   marketing (ya no la rechaza; el parámetro allow_category_change desapareció) y avisa
//   por el webhook template_category_update. Por eso: los seguimientos a leads dormidos se
//   piden como marketing desde el principio, y lo que puede ser utility se redacta sin
//   persuasión para que lo sea.
//
// El ORDEN de las variables es un contrato con el código que las llena:
//   followup_24h / reapertura → {{1}} nombre del lead, {{2}} producto (motor/followupEngine.js, api/inbox-actions.js)
//   compromiso                → {{1}} nombre del lead (motor/followupEngine.js)
//   aviso_vendedor            → {{1}} cliente, {{2}} motivo, {{3}} enlace wa.me (webhook/notifications.js)
// Si se cambia el orden aquí, hay que cambiarlo allá (y viceversa). tests/cloud-interactivos.test.js lo vigila.

import { readFileSync } from 'node:fs'
import { limpiarValor } from './plantillas.js'

export const IDIOMA_DEFAULT = 'es'
export const CATEGORIAS = Object.freeze(['marketing', 'utility', 'authentication'])

// Formato de los códigos de idioma de Meta: es, es_PE, es_MX, pt_BR, zh_CN, fil… (con guion
// bajo, nunca con guion: «es-PE» no existe para Meta y la plantilla no se encuentra: 132001).
const RX_IDIOMA = /^[a-z]{2,3}(_[A-Z]{2,4})?$/
export function idiomaValido(codigo) {
  return RX_IDIOMA.test(String(codigo || ''))
}

const datosCatalogo = JSON.parse(readFileSync(new URL('../../../data/plantillas-catalogo.json', import.meta.url), 'utf8'))
export const CATALOGO = Object.freeze(datosCatalogo.plantillas)

const RX_NOMBRE = /^[a-z0-9_]{1,512}$/

/** Números de las variables {{n}} que usa un cuerpo, en orden de aparición. */
export function variablesDelCuerpo(cuerpo) {
  return [...String(cuerpo).matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]))
}

/** Lista de problemas de una plantilla (vacía = lista para enviar a Meta). */
export function validarPlantilla(t) {
  const problemas = []
  if (!RX_NOMBRE.test(t?.nombre || '')) problemas.push(`nombre inválido «${t?.nombre}»: solo minúsculas, números y _`)
  if (!CATEGORIAS.includes(t?.categoria)) problemas.push(`categoría inválida «${t?.categoria}»`)

  const cuerpo = String(t?.cuerpo || '')
  if (!cuerpo.trim()) problemas.push('el cuerpo está vacío')
  if ([...cuerpo].length > 1024) problemas.push('el cuerpo pasa de 1024 caracteres')
  if (/^\s*\{\{/.test(cuerpo)) problemas.push('el cuerpo no puede EMPEZAR con una variable')
  if (/\}\}\s*$/.test(cuerpo)) problemas.push('el cuerpo no puede TERMINAR con una variable')
  if (/ {5,}|\n{3,}/.test(cuerpo)) problemas.push('el cuerpo tiene demasiados espacios o saltos de línea seguidos')

  const distintas = [...new Set(variablesDelCuerpo(cuerpo))]
  const correlativas = distintas.every((n, i) => n === i + 1)
  if (!correlativas) problemas.push(`las variables deben ser {{1}}, {{2}}… correlativas (hay ${distintas.map(n => `{{${n}}}`).join(' ')})`)
  if ((t?.ejemplos || []).length !== distintas.length) problemas.push(`hay ${distintas.length} variable(s) y ${(t?.ejemplos || []).length} ejemplo(s): Meta exige un ejemplo por variable`)
  if ((t?.variables || []).length !== distintas.length) problemas.push(`hay ${distintas.length} variable(s) y ${(t?.variables || []).length} descripción(es)`)
  return problemas
}

const componenteDeCuerpo = (t) => ({
  type: 'body',
  text: t.cuerpo,
  ...(t.ejemplos.length ? { example: { body_text: [t.ejemplos] } } : {})
})

/** Cuerpo del POST /{WABA_ID}/message_templates para crear una plantilla del catálogo. */
export function payloadDeCreacion(t, { idioma = IDIOMA_DEFAULT } = {}) {
  const problemas = validarPlantilla(t)
  if (!idiomaValido(idioma)) problemas.push(`idioma inválido «${idioma}» (usa es, es_PE, es_MX…)`)
  if (problemas.length) throw new Error(`plantilla «${t?.clave || t?.nombre}» inválida: ${problemas.join('; ')}`)
  return {
    name: t.nombre,
    language: idioma,
    category: t.categoria,
    parameter_format: 'positional',
    components: [componenteDeCuerpo(t)]
  }
}

/**
 * Cuerpo del POST /{TEMPLATE_ID} para EDITAR el texto de una plantilla ya creada. Es lo que
 * corresponde cuando Meta la rechazó o el catálogo cambió: si se BORRA una plantilla
 * aprobada, Meta no deja reusar su nombre por 30 días. Una rechazada o pausada se puede
 * editar sin límite; una aprobada, 1 vez cada 24 h y 10 cada 30 días (y vuelve a revisión).
 */
export function payloadDeEdicion(t) {
  const problemas = validarPlantilla(t)
  if (problemas.length) throw new Error(`plantilla «${t?.clave || t?.nombre}» inválida: ${problemas.join('; ')}`)
  return { components: [componenteDeCuerpo(t)] }
}

export const ESTADOS_EDITABLES = Object.freeze(['APPROVED', 'REJECTED', 'PAUSED'])

/** El texto del cuerpo tal como está en Meta (de GET …/message_templates?fields=components), o null. */
export function cuerpoEnMeta(plantillaDeMeta) {
  const cuerpo = (plantillaDeMeta?.components || []).find(c => String(c?.type || '').toUpperCase() === 'BODY')
  return typeof cuerpo?.text === 'string' ? cuerpo.text : null
}

/** Nombre real que el código usará: lo que diga la env var, o el del catálogo. */
export function nombreConfigurado(t, env = process.env) {
  return (env[t.env] || '').trim() || t.nombre
}

/** La entrada del catálogo que el código usa con ese nombre de plantilla (o null). */
export function plantillaPorNombre(nombre, env = process.env) {
  return CATALOGO.find(t => nombreConfigurado(t, env) === nombre) || null
}

/**
 * Lo que el cliente ve con una plantilla del catálogo, para guardarlo TAL CUAL en el
 * historial. Importa dos veces: la bandeja muestra lo que de verdad se envió, y el cerebro
 * (que arma su memoria con esa tabla) no "recuerda" haber dicho algo que el cliente nunca
 * leyó. Si la env var apunta a OTRA plantilla (creada a mano en Meta), no sabemos su texto:
 * se guarda un marcador honesto en vez de inventarlo.
 * NUNCA lanza: se usa justo alrededor de un envío real, y un error ahí dejaría un mensaje
 * enviado sin registrar (y el siguiente ciclo lo mandaría otra vez).
 */
export function textoDePlantilla(clave, variables = [], configuracion = process.env) {
  const t = CATALOGO.find(x => x.clave === clave)
  const esPolitica = Object.hasOwn(configuracion, 'plantilla')
  const nombre = esPolitica ? configuracion.plantilla : t ? nombreConfigurado(t, configuracion) : clave
  const idioma = configuracion.idioma || configuracion.CLOUD_TEMPLATE_IDIOMA || IDIOMA_DEFAULT
  const registro = esPolitica ? CATALOGO.find(x => x.nombre === nombre && idioma === IDIOMA_DEFAULT) : t
  const cuerpo = esPolitica ? configuracion.cuerpo || registro?.cuerpo : nombre === t?.nombre && idioma === IDIOMA_DEFAULT ? t.cuerpo : null
  if (!cuerpo) return `[plantilla «${nombre}» enviada]`
  return cuerpo.replace(/\{\{(\d+)\}\}/g, (_, n) => limpiarValor(variables[Number(n) - 1]) || '-')
}

/**
 * Compara el catálogo con las plantillas que ya hay en Meta. Pura: scripts/meta-plantillas.js
 * solo hace la red. `existentes` = lo que devuelve GET /{WABA}/message_templates (con
 * fields=name,status,category,language,rejected_reason,quality_score,components).
 *
 * `gestionada` = el nombre configurado es el del catálogo, así que el texto es NUESTRO: se
 * puede crear/editar y el historial guarda ese texto. Si la env var apunta a otra plantilla,
 * la maneja el equipo en el panel de Meta y aquí solo se informa su estado.
 * `textoDifiere` = el cuerpo en Meta no es el del catálogo (alguien la editó en el panel, o
 * cambió el catálogo): el historial estaría guardando un texto que el cliente no ve.
 * @returns {{ clave, env, nombre, t, enMeta, estado, gestionada, textoDifiere, calidad, otrosIdiomas }[]}
 */
export function planificarPlantillas({ existentes = [], idioma = IDIOMA_DEFAULT, env = process.env, solo = null } = {}) {
  return CATALOGO.filter(t => !solo || t.clave === solo).map((t) => {
    const nombre = nombreConfigurado(t, env)
    const gestionada = nombre === t.nombre
    const mismas = existentes.filter(e => e?.name === nombre)
    const enMeta = mismas.find(e => e.language === idioma) || null
    const cuerpo = cuerpoEnMeta(enMeta)
    return {
      clave: t.clave,
      env: t.env,
      nombre,
      t,
      enMeta,
      estado: enMeta ? String(enMeta.status || '?').toUpperCase() : 'FALTA',
      gestionada,
      textoDifiere: gestionada && cuerpo != null ? cuerpo.trim() !== t.cuerpo.trim() : false,
      calidad: enMeta?.quality_score?.score || null,
      // El error más común: la plantilla existe, pero en otro idioma (es_PE vs es).
      otrosIdiomas: mismas.filter(e => e.language !== idioma).map(e => e.language)
    }
  })
}

/** Las líneas CLOUD_TEMPLATE_* de las plantillas APROBADAS, listas para pegar en Render. */
export function lineasDeEntorno(plan, idioma = IDIOMA_DEFAULT) {
  const lineas = plan.filter(p => p.estado === 'APPROVED').map(p => `${p.env}=${p.nombre}`)
  if (lineas.length && idioma !== IDIOMA_DEFAULT) lineas.push(`CLOUD_TEMPLATE_IDIOMA=${idioma}`)
  return lineas
}

// Estados en los que los envíos con esa plantilla FALLAN (132001/132015/132016…).
const ESTADOS_QUE_BLOQUEAN = new Set(['REJECTED', 'PAUSED', 'DISABLED', 'LIMIT_EXCEEDED', 'LOCKED', 'PENDING_DELETION', 'DELETED', 'ARCHIVED'])

/**
 * Traduce un aviso de Meta sobre una plantilla (webhooks message_template_status_update,
 * template_category_update, message_template_quality_update; ver cloud/parser.js) a una
 * línea de log que dice QUÉ parte del bot se ve afectada. Una plantilla pausada no hace
 * ruido por sí sola: los seguimientos simplemente dejan de salir.
 * @returns {{ nivel: 'info'|'warn', linea: string }}
 */
export function describirEventoDePlantilla(ev, env = process.env) {
  const t = ev?.nombre ? plantillaPorNombre(ev.nombre, env) : null
  const quien = t ? ` — la usa ${t.env}: ${t.uso.replace(/\.$/, '')}` : ''
  const cual = `«${ev?.nombre || '?'}» [${ev?.idioma || '?'}]`

  if (ev?.cambio === 'estado') {
    const estado = String(ev.estado || '?').toUpperCase()
    const motivo = ev.motivo && ev.motivo !== 'NONE' ? ` (${ev.motivo})` : ''
    const detalle = ev.detalle ? `: ${ev.detalle}` : ''
    if (ESTADOS_QUE_BLOQUEAN.has(estado) || estado === 'FLAGGED') {
      const consecuencia = ESTADOS_QUE_BLOQUEAN.has(estado)
        ? (t ? ' → esos envíos FALLAN mientras siga así' : '')
        : ' → calidad en riesgo: si baja más, Meta la pausa'
      return { nivel: 'warn', linea: `⚠ plantilla ${cual} ${estado}${motivo}${detalle}${quien}${consecuencia}` }
    }
    const como = estado === 'APPROVED' && ev.categoria ? ` como ${String(ev.categoria).toUpperCase()}` : ''
    return { nivel: 'info', linea: `✔ plantilla ${cual} ${estado}${como}${quien}` }
  }

  if (ev?.cambio === 'categoria') {
    if (ev.categoriaCorrecta) {
      const cuando = ev.desde ? ` el ${new Date(Number(ev.desde) * 1000).toISOString().slice(0, 10)}` : ''
      return { nivel: 'warn', linea: `⚠ Meta va a pasar la plantilla ${cual} de ${ev.categoriaNueva || '?'} a ${ev.categoriaCorrecta}${cuando}${quien} → se cobrará como ${ev.categoriaCorrecta}` }
    }
    return { nivel: 'warn', linea: `⚠ Meta cambió la categoría de la plantilla ${cual}: ${ev.categoriaAnterior || '?'} → ${ev.categoriaNueva || '?'}${quien} → se cobra como ${ev.categoriaNueva || '?'}` }
  }

  if (ev?.cambio === 'calidad') {
    const roja = String(ev.calidadNueva || '').toUpperCase() === 'RED'
    return {
      nivel: roja ? 'warn' : 'info',
      linea: `${roja ? '⚠ ' : ''}plantilla ${cual} calidad ${ev.calidadAnterior || '?'} → ${ev.calidadNueva || '?'}${quien}${roja ? ' → riesgo de pausa: revisar el texto y a quién se le envía' : ''}`
    }
  }

  return { nivel: 'info', linea: `plantilla ${cual}: aviso de Meta sin interpretar (${ev?.cambio || '?'})` }
}

export const CLOUD_PLANTILLAS_CATALOGO_VERSION = 'v2_texto_real_plan_y_avisos'
