// src/whatsapp/cloud/interactivos.js — mensajes INTERACTIVOS de Meta (sep 2026)
//
// POR QUÉ EXISTE (lo aprendido del ejemplo oficial de Meta, Jasper's Market):
//   Un cliente que toca un botón responde en un segundo y sin escribir; uno que tiene que
//   redactar una respuesta se pierde a mitad de camino. Meta da tres formatos, TODOS
//   gratis dentro de la ventana de 24 h (son mensajes libres, no plantillas):
//     · botones de respuesta  — hasta 3, para decisiones rápidas ("Sí, pedirlo" / "Tengo una duda")
//     · lista                 — hasta 10 filas, para menús (productos, horarios, ciudades)
//     · botón de enlace       — un botón que abre una URL (pago, catálogo, tienda)
//
// Este módulo SOLO arma y valida el objeto `interactive` (funciones puras, sin red). Los
// límites son los de la documentación de Meta: pasarse no da un error del bot sino un 400
// de Graph que el cliente nunca ve, así que se falla aquí, con un mensaje que se entiende.
// El envío lo hace cloud/sender.js (sendInteractiveCloud); por transporte, whatsapp/interactivo.js.
//
// Cuando el cliente toca algo, el webhook trae interactive.button_reply / list_reply con el
// `id` que se puso AQUÍ (no solo el texto): por eso cada opción lleva un id propio y estable.

export const LIMITES = Object.freeze({
  botonesMax: 3,
  botonTitulo: 20,
  botonId: 256,
  cuerpo: 1024,            // botones y botón de enlace
  cuerpoLista: 4096,       // la lista admite un cuerpo más largo
  encabezado: 60,
  pie: 60,
  listaBoton: 20,
  listaFilasMax: 10,
  listaSeccionesMax: 10,
  listaSeccionTitulo: 24,
  listaFilaTitulo: 24,
  listaFilaDescripcion: 72,
  listaFilaId: 200,
  enlaceTexto: 20
})

export class ErrorInteractivo extends Error {
  constructor(mensaje) {
    super(mensaje)
    this.name = 'ErrorInteractivo'
  }
}

// Cómo cuenta Meta los caracteres no está documentado (¿un emoji vale 1 o 2?). Se cuenta
// como JavaScript (unidades UTF-16: los emojis fuera del plano básico, como 🙌 o 😊, valen 2)
// porque es la cuenta más estricta de las posibles: nunca deja pasar algo que Meta rechace.
// El costo es perder a lo sumo un carácter en un título con emoji; el de equivocarse al revés
// sería un 400 de Graph y un cliente sin respuesta.
const largo = (s) => String(s).length

function texto(campo, valor, max, { requerido = true } = {}) {
  const v = typeof valor === 'string' ? valor.trim() : ''
  if (!v) {
    if (requerido) throw new ErrorInteractivo(`${campo} es obligatorio`)
    return null
  }
  if (largo(v) > max) throw new ErrorInteractivo(`${campo} pasa de ${max} caracteres (tiene ${largo(v)}): «${v.slice(0, 30)}…»`)
  return v
}

function idUnico(campo, id, max, vistos) {
  const v = typeof id === 'string' ? id.trim() : ''
  if (!v) throw new ErrorInteractivo(`${campo}: falta el id`)
  if (largo(v) > max) throw new ErrorInteractivo(`${campo}: el id pasa de ${max} caracteres`)
  if (vistos.has(v)) throw new ErrorInteractivo(`${campo}: el id «${v}» está repetido (cada opción necesita uno propio)`)
  vistos.add(v)
  return v
}

/** Encabezado de texto + pie, comunes a los tres formatos. */
function marco({ encabezado, pie }) {
  const out = {}
  const h = texto('encabezado', encabezado, LIMITES.encabezado, { requerido: false })
  if (h) out.header = { type: 'text', text: h }
  const f = texto('pie', pie, LIMITES.pie, { requerido: false })
  if (f) out.footer = { text: f }
  return out
}

/**
 * Botones de respuesta rápida (1 a 3).
 * @param {{cuerpo:string, botones:{id:string,titulo:string}[], encabezado?:string, pie?:string}} a
 */
export function botonesDeRespuesta({ cuerpo, botones, encabezado, pie }) {
  if (!Array.isArray(botones) || botones.length < 1 || botones.length > LIMITES.botonesMax) {
    throw new ErrorInteractivo(`los botones de respuesta son de 1 a ${LIMITES.botonesMax} (llegaron ${Array.isArray(botones) ? botones.length : 0})`)
  }
  const vistos = new Set()
  return {
    type: 'button',
    ...marco({ encabezado, pie }),
    body: { text: texto('cuerpo', cuerpo, LIMITES.cuerpo) },
    action: {
      buttons: botones.map((b, i) => ({
        type: 'reply',
        reply: {
          id: idUnico(`botón ${i + 1}`, b?.id, LIMITES.botonId, vistos),
          title: texto(`botón ${i + 1} (título)`, b?.titulo, LIMITES.botonTitulo)
        }
      }))
    }
  }
}

/**
 * Lista desplegable (hasta 10 filas en total, repartidas en secciones).
 * @param {{cuerpo:string, boton:string, secciones:{titulo?:string, filas:{id:string,titulo:string,descripcion?:string}[]}[], encabezado?:string, pie?:string}} a
 */
export function listaDeOpciones({ cuerpo, boton, secciones, encabezado, pie }) {
  if (!Array.isArray(secciones) || secciones.length < 1 || secciones.length > LIMITES.listaSeccionesMax) {
    throw new ErrorInteractivo(`la lista lleva de 1 a ${LIMITES.listaSeccionesMax} secciones`)
  }
  const total = secciones.reduce((n, s) => n + (Array.isArray(s?.filas) ? s.filas.length : 0), 0)
  if (total < 1 || total > LIMITES.listaFilasMax) {
    throw new ErrorInteractivo(`la lista lleva de 1 a ${LIMITES.listaFilasMax} filas en total (llegaron ${total})`)
  }
  const vistos = new Set()
  return {
    type: 'list',
    ...marco({ encabezado, pie }),
    body: { text: texto('cuerpo', cuerpo, LIMITES.cuerpoLista) },
    action: {
      button: texto('botón de la lista', boton, LIMITES.listaBoton),
      sections: secciones.map((s, i) => {
        // Con varias secciones, cada una necesita título; con una sola es opcional.
        const titulo = texto(`sección ${i + 1} (título)`, s?.titulo, LIMITES.listaSeccionTitulo, { requerido: secciones.length > 1 })
        return {
          ...(titulo ? { title: titulo } : {}),
          rows: (s?.filas || []).map((f, j) => {
            const descripcion = texto(`fila ${j + 1} (descripción)`, f?.descripcion, LIMITES.listaFilaDescripcion, { requerido: false })
            return {
              id: idUnico(`fila ${j + 1}`, f?.id, LIMITES.listaFilaId, vistos),
              title: texto(`fila ${j + 1} (título)`, f?.titulo, LIMITES.listaFilaTitulo),
              ...(descripcion ? { description: descripcion } : {})
            }
          })
        }
      })
    }
  }
}

/**
 * Un botón que abre una URL (pago, catálogo, ficha del producto).
 * @param {{cuerpo:string, texto:string, url:string, encabezado?:string, pie?:string}} a
 */
export function botonDeEnlace({ cuerpo, texto: etiqueta, url, encabezado, pie }) {
  if (!/^https?:\/\/\S+$/i.test(String(url || '').trim())) throw new ErrorInteractivo('el enlace debe ser una URL http(s) completa')
  return {
    type: 'cta_url',
    ...marco({ encabezado, pie }),
    body: { text: texto('cuerpo', cuerpo, LIMITES.cuerpo) },
    action: {
      name: 'cta_url',
      parameters: { display_text: texto('texto del botón', etiqueta, LIMITES.enlaceTexto), url: String(url).trim() }
    }
  }
}

/**
 * Elige el formato según cuántas opciones hay: hasta 3 → botones; hasta 10 → lista de una
 * sola sección. Es lo que quiere quien solo tiene "un texto y unas opciones": no le importa
 * el formato, le importa que el cliente pueda tocar.
 * @param {{cuerpo:string, opciones:{id:string,titulo:string,descripcion?:string}[], boton?:string, encabezado?:string, pie?:string}} a
 */
export function interactivoDeOpciones({ cuerpo, opciones, boton = 'Ver opciones', encabezado, pie }) {
  if (!Array.isArray(opciones) || opciones.length < 1) throw new ErrorInteractivo('faltan opciones')
  const cabenEnBotones = opciones.length <= LIMITES.botonesMax
    && opciones.every(o => largo(o?.titulo || '') <= LIMITES.botonTitulo && !o?.descripcion)
  if (cabenEnBotones) return botonesDeRespuesta({ cuerpo, botones: opciones, encabezado, pie })
  return listaDeOpciones({ cuerpo, boton, secciones: [{ filas: opciones }], encabezado, pie })
}

/**
 * Las mismas opciones como TEXTO numerado, para los canales sin botones (Evolution, o una
 * conversación fuera de ventana donde no se puede mandar interactivo). El cliente responde
 * con el número o con la palabra: el cerebro ya entiende ambas.
 */
export function opcionesComoTexto(cuerpo, opciones) {
  const lineas = (opciones || []).map((o, i) => `${i + 1}) ${o.titulo}${o.descripcion ? ` — ${o.descripcion}` : ''}`)
  return [String(cuerpo || '').trim(), ...(lineas.length ? ['', ...lineas] : [])].join('\n').trim()
}

export const CLOUD_INTERACTIVOS_VERSION = 'v2_cuenta_estricta'
