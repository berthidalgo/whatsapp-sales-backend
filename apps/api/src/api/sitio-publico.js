// src/api/sitio-publico.js — la web pública del negocio: inicio (/) y privacidad (/privacidad) (sep 2026)
//
// Meta RESTRINGIÓ la cuenta de WhatsApp del negocio porque la "web" del portafolio era la
// página de Facebook, que su revisor no puede leer sin sesión: no pudo ver QUÉ se vende para
// compararlo con la Política comercial de WhatsApp. Esta página se lo dice en claro (quién,
// qué vende, cómo se compra, datos del negocio) y es la URL que va en el portafolio.
// /privacidad la exige Meta para publicar la app; #eliminar sirve de "instrucciones para
// eliminar datos" si la pide.
//
// Todo es texto fijo, sin scripts ni recursos externos. Los datos del negocio son los del
// portafolio de Meta: si cambian allá, cambiarlos en data/sitio-publico.json,
// porque Meta compara (F2 forense: antes vivían cosidos aquí).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

function cargarSitio() {
  const ruta = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'sitio-publico.json')
  return JSON.parse(readFileSync(ruta, 'utf8'))
}

const DATOS = cargarSitio()

export const NEGOCIO = DATOS.negocio

function escaparHtml(valor) { return String(valor ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
function contenido(plantilla) {
  const rubrosHtml=DATOS.rubros.map(r=>'  <div class="rubro"><h3>'+escaparHtml(r.titulo)+'</h3><p>'+escaparHtml(r.texto)+'</p></div>').join('\n')
  return plantilla.replace(/\{\{([a-zA-Z.]+)\}\}/g,(_,key)=> {
    if(key==='rubrosHtml')return rubrosHtml
    const valor=key.startsWith('negocio.') ? DATOS.negocio[key.slice(8)] : DATOS[key]
    if(valor===undefined)throw new Error('Dato del sitio ausente: '+key)
    return escaparHtml(valor)
  })
}
function construirPagina(clave) {
  const p=DATOS.paginas[clave]
  return pagina(contenido(p.titulo),contenido(p.descripcion),contenido(p.cuerpo))
}

const ESTILOS = `
  :root { --fondo: #ffffff; --texto: #1f2328; --suave: #59636e; --linea: #d1d9e0; --tarjeta: #f6f8fa; --marca: #0b6b3a; --marca-texto: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --fondo: #0d1117; --texto: #e6edf3; --suave: #9198a1; --linea: #3d444d; --tarjeta: #161b22; --marca: #2ea043; --marca-texto: #ffffff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fondo); color: var(--texto); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 8px; }
  h2 { font-size: 1.2rem; margin: 32px 0 12px; padding-top: 16px; border-top: 1px solid var(--linea); }
  h3 { font-size: 1.05rem; margin: 0 0 4px; }
  p, ul, ol { margin: 0 0 12px; }
  ul, ol { padding-left: 22px; }
  a { color: inherit; }
  .suave { color: var(--suave); }
  .boton { display: inline-block; margin-top: 8px; padding: 12px 20px; border-radius: 8px; background: var(--marca); color: var(--marca-texto); text-decoration: none; font-weight: 600; }
  .rubros { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  .rubro { background: var(--tarjeta); border: 1px solid var(--linea); border-radius: 10px; padding: 16px; }
  .rubro p { margin: 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
  dt { color: var(--suave); }
  dd { margin: 0; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--linea); color: var(--suave); font-size: 0.9rem; }
`

const pagina = (titulo, descripcion, cuerpo) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo}</title>
<meta name="description" content="${descripcion}">
<style>${ESTILOS}</style>
</head>
<body>
<main>
${cuerpo}
<footer>
<p>© ${DATOS.copyrightYear} ${NEGOCIO.nombre} · RUC ${NEGOCIO.ruc} · <a href="/">Inicio</a> · <a href="/privacidad">Política de privacidad</a></p>
</footer>
</main>
</body>
</html>
`

export const HTML_INICIO = construirPagina('inicio')

export const HTML_PRIVACIDAD = construirPagina('privacidad')

const enviar = (html) => async (req, reply) =>
  reply.code(200).type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(html)

export const paginaInicio = enviar(HTML_INICIO)
export const paginaPrivacidad = enviar(HTML_PRIVACIDAD)
