// src/whatsapp/cloud/plantillas.js — parámetros de PLANTILLAS de Meta al ENVIAR (sep 2026)
//
// Cuando se envía una plantilla, el JSON NO lleva el texto: el texto, el pie y los botones
// los guardó Meta al aprobarla. Solo viajan el nombre y los VALORES de lo que la plantilla
// dejó variable: las {{1}} del cuerpo, la imagen del encabezado, el cupón, la cuenta
// regresiva de una oferta, la imagen de cada tarjeta de un carrusel. Esos valores van en
// `components`, y ahí es fácil equivocarse por un índice o un sub_type mal escrito — Meta
// contesta 132000/132012 (parámetros que no calzan) y el cliente no recibe nada.
//
// Estas funciones puras arman esos `components` para sendTemplateCloud()/enviarPlantilla().
// Los formatos de oferta por tiempo limitado y carrusel salen del ejemplo oficial de Meta
// (Jasper's Market) y de su documentación. Nada aquí hace red.
//
// Por qué importan para VENDER:
//   · Oferta por tiempo limitado (limited_time_offer): cuenta regresiva + botón "copiar
//     cupón". Crea urgencia real y se puede mandar FUERA de la ventana de 24 h.
//   · Carrusel: 2 a 10 tarjetas con foto y botón — un catálogo dentro del chat.
//   Ambos son plantillas de categoría MARKETING: se cobran por mensaje entregado y están
//   sujetas al tope de mensajes de marketing por usuario (error 131049).
//
// ÍNDICE DE LOS BOTONES — el detalle que más envíos rompe:
//   En `components`, cada botón se identifica por su POSICIÓN en la plantilla (`index`),
//   contando también los botones FIJOS (una URL sin variable, una respuesta rápida) aunque
//   esos no lleven parámetros y no se manden. Por defecto se asume que la plantilla tiene
//   solo los botones a los que les pasas valor, en el orden de la documentación de Meta
//   (cupón antes que URL; respuesta rápida antes que URL). Si tu plantilla tiene otro orden
//   o botones fijos delante, pásale `ordenBotones`: la lista COMPLETA de sus botones, en
//   orden. Ej.: plantilla [URL fija, copiar cupón] → ordenBotones: ['url', 'cupon'] y el
//   cupón sale con index 1.

export class ErrorPlantilla extends Error {
  constructor(mensaje) {
    super(mensaje)
    this.name = 'ErrorPlantilla'
  }
}

// Meta rechaza valores de parámetros con saltos de línea, tabulaciones o más de 4 espacios seguidos.
const limpio = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()

/** El mismo saneo que se aplica al enviar: sirve para guardar en el historial lo que Meta mostró. */
export const limpiarValor = limpio

/**
 * Red de seguridad del último metro (la usa sendTemplateCloud para TODOS los envíos de
 * plantilla, los arme quien los arme): limpia los valores de TEXTO con las reglas de Meta y,
 * en cuerpo y encabezado, nunca los deja vacíos ('-'). Sin esto, un nombre con un Enter
 * pegado o un producto vacío hacen que Meta rechace el envío entero. No toca imágenes,
 * cupones, payloads ni la estructura. Devuelve una copia.
 */
export function sanearComponentes(components) {
  if (!Array.isArray(components)) return []
  return components.map((c) => {
    if (!c || typeof c !== 'object') return c
    const out = { ...c }
    if (Array.isArray(c.parameters)) {
      const obligatorio = c.type === 'body' || c.type === 'header'
      out.parameters = c.parameters.map((p) =>
        p?.type === 'text' ? { ...p, text: limpio(p.text) || (obligatorio ? '-' : '') } : p)
    }
    if (Array.isArray(c.cards)) {
      out.cards = c.cards.map((card) => ({ ...card, components: sanearComponentes(card?.components) }))
    }
    return out
  })
}

/** Variables del cuerpo: ['María', 'colágeno'] → {{1}}, {{2}}. */
export function componenteCuerpo(variables = []) {
  if (!Array.isArray(variables) || variables.length === 0) return []
  return [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: limpio(v) || '-' })) }]
}

/**
 * Imagen del encabezado. Se identifica por `id` (media ya subida a Meta; caduca a los 30
 * días y es del número que la subió) o por `link` (URL pública https).
 */
export function componenteEncabezadoImagen({ id, link } = {}) {
  return { type: 'header', parameters: [{ type: 'image', image: imagen({ id, link }) }] }
}

function imagen({ id, link }) {
  if (id) return { id: String(id) }
  if (link && /^https:\/\/\S+$/i.test(String(link))) return { link: String(link) }
  throw new ErrorPlantilla('la imagen necesita `id` (media subida a Meta) o `link` (URL https pública)')
}

/** Botón que copia un cupón. `indice` = posición del botón dentro de la plantilla (0 = el primero). */
export function componenteBotonCupon(cupon, indice = 0) {
  const c = limpio(cupon)
  // Meta: hasta 20 caracteres desde dic-2025 (su página de plantillas aún dice 15, pero el
  // changelog del 3-dic-2025 lo subió). Si una cuenta rechazara uno de 16-20, Graph lo dirá claro.
  if (!c || c.length > 20) throw new ErrorPlantilla('el cupón es obligatorio y de hasta 20 caracteres')
  return { type: 'button', sub_type: 'copy_code', index: indice, parameters: [{ type: 'coupon_code', coupon_code: c }] }
}

/** Botón de URL con la parte variable (la plantilla trae la URL base con {{1}} al final). */
export function componenteBotonUrl(sufijo, indice = 0) {
  const s = limpio(sufijo)
  if (!s) throw new ErrorPlantilla('el botón de URL necesita el valor que reemplaza {{1}}')
  return { type: 'button', sub_type: 'url', index: indice, parameters: [{ type: 'text', text: s }] }
}

/** Botón de respuesta rápida de una plantilla: el `payload` vuelve en el webhook cuando lo tocan. */
export function componenteBotonRespuesta(payload, indice = 0) {
  const p = String(payload ?? '').trim()
  if (!p || p.length > 128) throw new ErrorPlantilla('el payload del botón es obligatorio y de hasta 128 caracteres')
  return { type: 'button', sub_type: 'quick_reply', index: indice, parameters: [{ type: 'payload', payload: p }] }
}

const tieneValor = (v) => v != null && String(v).trim() !== ''

/**
 * Componentes de botón con el `index` correcto (ver "ÍNDICE DE LOS BOTONES" arriba).
 * @param {object} a
 * @param {string[]|undefined} a.ordenBotones  todos los botones de la plantilla, en orden
 * @param {Record<string, any>} a.valores       valor por tipo de botón (sin valor = fijo o ausente)
 * @param {Record<string, Function>} a.constructores
 * @param {string[]} a.canonico                 orden por defecto (el de la documentación)
 */
function botonesConIndice({ ordenBotones, valores, constructores, canonico }) {
  const orden = ordenBotones || canonico.filter((tipo) => tieneValor(valores[tipo]))
  if (!Array.isArray(orden)) throw new ErrorPlantilla('`ordenBotones` debe ser una lista, p. ej. [\'url\', \'cupon\']')
  for (const tipo of orden) {
    if (!constructores[tipo]) throw new ErrorPlantilla(`botón «${tipo}» desconocido (usa: ${Object.keys(constructores).join(', ')})`)
  }
  if (new Set(orden).size !== orden.length) {
    throw new ErrorPlantilla('hay dos botones del mismo tipo: arma esos componentes a mano con componenteBoton*(valor, indice)')
  }
  for (const [tipo, v] of Object.entries(valores)) {
    if (tieneValor(v) && !orden.includes(tipo)) throw new ErrorPlantilla(`pasaste valor para el botón «${tipo}» pero no está en ordenBotones`)
  }
  return orden.flatMap((tipo, i) => (tieneValor(valores[tipo]) ? [constructores[tipo](valores[tipo], i)] : []))
}

/**
 * OFERTA POR TIEMPO LIMITADO.
 *
 * Orden de los componentes = el de la documentación de Meta. `expiraEn` es un Date o un
 * timestamp en milisegundos (fecha ABSOLUTA, no "dentro de N horas"). Meta lo muestra como
 * cuenta regresiva; WhatsApp Web y escritorio NO la muestran (solo el celular).
 * Reglas de la plantilla (al crearla, no aquí): solo marketing, sin pie, cuerpo ≤ 600.
 *
 * @param {object} a
 * @param {string[]} [a.variables]        {{1}}… del cuerpo
 * @param {{id?:string,link?:string}} a.imagen  encabezado (imagen o video: aquí solo imagen)
 * @param {Date|number} a.expiraEn        cuándo vence la oferta
 * @param {string} [a.cupon]              si la plantilla tiene botón "copiar cupón"
 * @param {string} [a.sufijoUrl]          si la plantilla tiene botón de URL con {{1}}
 * @param {('cupon'|'url')[]} [a.ordenBotones]  solo si la plantilla no sigue el orden por defecto
 * @param {number} [a.ahora]              solo para pruebas
 */
export function componentesOfertaLimitada({ variables = [], imagen: img, expiraEn, cupon, sufijoUrl, ordenBotones, ahora = Date.now() }) {
  if (expiraEn == null) throw new ErrorPlantilla('falta `expiraEn`: la oferta necesita su fecha de vencimiento (Date o milisegundos)')
  const ms = expiraEn instanceof Date ? expiraEn.getTime() : Number(expiraEn)
  if (!Number.isFinite(ms)) throw new ErrorPlantilla('`expiraEn` no es una fecha válida')
  if (ms <= ahora) throw new ErrorPlantilla('la oferta ya venció: `expiraEn` debe ser una fecha futura')

  return [
    componenteEncabezadoImagen(img || {}),
    ...componenteCuerpo(variables),
    { type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: ms } }] },
    ...botonesConIndice({
      ordenBotones,
      valores: { cupon, url: sufijoUrl },
      constructores: { cupon: componenteBotonCupon, url: componenteBotonUrl },
      canonico: ['cupon', 'url']
    })
  ]
}

/**
 * CARRUSEL de tarjetas con imagen (2 a 10). Todas las tarjetas deben tener los MISMOS
 * componentes que la plantilla definió: si la plantilla lleva un botón de URL con variable
 * por tarjeta, todas traen `sufijoUrl`; si lleva respuesta rápida, todas traen `payload`.
 * Un botón de URL FIJA no lleva valor (como en el ejemplo de Meta: su carrusel no manda
 * ningún componente de botón).
 *
 * @param {object} a
 * @param {string[]} [a.variables]  {{1}}… del cuerpo principal (el mensaje sobre el carrusel)
 * @param {{imagen:{id?:string,link?:string}, sufijoUrl?:string, payload?:string}[]} a.tarjetas
 * @param {('respuesta'|'url')[]} [a.ordenBotones]  solo si las tarjetas no siguen el orden por defecto
 */
export function componentesCarrusel({ variables = [], tarjetas, ordenBotones }) {
  if (!Array.isArray(tarjetas) || tarjetas.length < 2 || tarjetas.length > 10) {
    throw new ErrorPlantilla(`un carrusel lleva de 2 a 10 tarjetas (llegaron ${Array.isArray(tarjetas) ? tarjetas.length : 0})`)
  }
  const forma = (t) => `${tieneValor(t?.payload) ? 'R' : ''}${tieneValor(t?.sufijoUrl) ? 'U' : ''}`
  const primera = forma(tarjetas[0])
  tarjetas.forEach((t, i) => {
    if (forma(t) !== primera) throw new ErrorPlantilla(`la tarjeta ${i + 1} no tiene los mismos botones que la primera: en un carrusel todas llevan los mismos componentes`)
  })

  return [
    ...componenteCuerpo(variables),
    {
      type: 'carousel',
      cards: tarjetas.map((t, i) => ({
        card_index: i,
        components: [
          componenteEncabezadoImagen(t.imagen || {}),
          ...botonesConIndice({
            ordenBotones,
            valores: { respuesta: t.payload, url: t.sufijoUrl },
            constructores: { respuesta: componenteBotonRespuesta, url: componenteBotonUrl },
            canonico: ['respuesta', 'url']
          })
        ]
      }))
    }
  ]
}

export const CLOUD_PLANTILLAS_VERSION = 'v2_indice_de_botones_y_saneo'
