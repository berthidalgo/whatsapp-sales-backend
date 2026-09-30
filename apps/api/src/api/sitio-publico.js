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
// portafolio de Meta (Hidata impor): si cambian allá, cambiarlos aquí, porque Meta compara.

export const NEGOCIO = {
  nombre: 'Hidata Importaciones',
  titular: 'Joan Alberth Cornelio Hidalgo Tacas',
  ruc: '10721689421',
  direccion: 'Av. Flor de Amancaes N.° 10, Mz. 1, Lt. 6, Rímac, Lima 15011, Perú',
  correo: 'albert.hidata@gmail.com',
  telefono: '+51 923 913 984',
  whatsapp: '51923913984'
}

const ACTUALIZADA = '29 de septiembre de 2026'

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
<p>© 2026 ${NEGOCIO.nombre} · RUC ${NEGOCIO.ruc} · <a href="/">Inicio</a> · <a href="/privacidad">Política de privacidad</a></p>
</footer>
</main>
</body>
</html>
`

export const HTML_INICIO = pagina(
  `${NEGOCIO.nombre} · Tienda online de productos importados`,
  'Tienda online de productos importados en Perú: juguetes, hogar y tecnología. Pedidos online y por WhatsApp, envíos a todo el Perú y pago contraentrega.',
  `<h1>${NEGOCIO.nombre}</h1>
<p>Tienda online de <strong>productos importados</strong> en Perú: juguetes, artículos para el hogar y tecnología.
Vendemos online y por WhatsApp, enviamos a todo el Perú y pagas al recibir.</p>
<a class="boton" href="https://wa.me/${NEGOCIO.whatsapp}">Escríbenos por WhatsApp</a>

<h2>Qué vendemos</h2>
<div class="rubros">
  <div class="rubro"><h3>Juguetes</h3><p>Juguetes importados para niños y para regalar.</p></div>
  <div class="rubro"><h3>Hogar</h3><p>Productos importados prácticos para la casa: cocina, limpieza, orden y decoración.</p></div>
  <div class="rubro"><h3>Tecnología</h3><p>Gadgets y accesorios de tecnología para el día a día.</p></div>
</div>
<p class="suave" style="margin-top:12px">Renovamos el catálogo con frecuencia: seleccionamos productos importados y vamos sumando novedades.
Escríbenos para conocer lo que tenemos disponible hoy.</p>

<h2>Cómo comprar</h2>
<ol>
  <li>Haz tu pedido desde nuestras páginas de venta, o escríbenos por WhatsApp y cuéntanos qué producto te interesa.</li>
  <li>Te confirmamos el precio, la disponibilidad y los datos de envío.</li>
  <li>Enviamos tu pedido a cualquier parte del Perú.</li>
  <li>Pagas contraentrega, al recibirlo: en efectivo, Yape, Plin o transferencia.</li>
</ol>
<p>Si tu pedido llega con algún problema, escríbenos por el mismo WhatsApp y lo resolvemos.</p>

<h2>Datos del negocio</h2>
<dl>
  <dt>Nombre comercial</dt><dd>${NEGOCIO.nombre}</dd>
  <dt>Titular</dt><dd>${NEGOCIO.titular}</dd>
  <dt>RUC</dt><dd>${NEGOCIO.ruc}</dd>
  <dt>Dirección</dt><dd>${NEGOCIO.direccion}</dd>
  <dt>Correo</dt><dd><a href="mailto:${NEGOCIO.correo}">${NEGOCIO.correo}</a></dd>
  <dt>Teléfono y WhatsApp</dt><dd>${NEGOCIO.telefono}</dd>
</dl>`
)

export const HTML_PRIVACIDAD = pagina(
  `Política de privacidad · ${NEGOCIO.nombre}`,
  `Cómo ${NEGOCIO.nombre} trata los datos personales de quienes le escriben por WhatsApp.`,
  `<h1>Política de privacidad</h1>
<p class="suave">${NEGOCIO.nombre} · Última actualización: ${ACTUALIZADA}</p>
<p>Esta política explica cómo tratamos los datos personales de las personas que nos escriben por WhatsApp,
conforme a la Ley N.° 29733, Ley de Protección de Datos Personales del Perú, y su reglamento.</p>

<h2>1. Quién es responsable de tus datos</h2>
<p>${NEGOCIO.titular}, con nombre comercial <strong>${NEGOCIO.nombre}</strong>, RUC ${NEGOCIO.ruc},
con domicilio en ${NEGOCIO.direccion}. Contacto: <a href="mailto:${NEGOCIO.correo}">${NEGOCIO.correo}</a>.</p>

<h2>2. Qué datos tratamos</h2>
<ul>
  <li>Tu número de teléfono y el nombre de tu perfil de WhatsApp.</li>
  <li>Lo que nos envías por el chat: mensajes de texto, notas de voz, fotos y documentos.</li>
  <li>Los datos que nos das para un pedido: nombre, dirección de entrega y lo necesario para entregarlo.</li>
  <li>Si llegaste desde un anuncio, la referencia del anuncio que te trajo.</li>
</ul>
<p>No te pedimos datos sensibles.</p>

<h2>3. Para qué los usamos</h2>
<ul>
  <li>Responder tus consultas y asesorarte.</li>
  <li>Tomar y coordinar tus pedidos y sus entregas.</li>
  <li>Hacer seguimiento a tu consulta por WhatsApp, respetando las reglas de WhatsApp. Si nos pides que no te escribamos, dejamos de hacerlo.</li>
  <li>Mejorar nuestra atención con estadísticas internas.</li>
</ul>
<p>No vendemos ni alquilamos tus datos.</p>

<h2>4. Respuestas automáticas</h2>
<p>Parte de las respuestas las prepara un asistente automático con inteligencia artificial.
En cualquier momento puedes pedir que te atienda una persona.</p>

<h2>5. Con quién los compartimos</h2>
<p>Solo con los proveedores que necesitamos para operar, que los tratan por encargo nuestro:</p>
<ul>
  <li>Meta Platforms (WhatsApp Business Platform), para enviar y recibir los mensajes.</li>
  <li>Proveedores de servidores y base de datos en la nube (hoy Render y Supabase).</li>
  <li>Proveedores de inteligencia artificial que procesan el texto, las notas de voz o las fotos para ayudarnos a responder
  (por ejemplo Mistral AI, Groq, OpenRouter o Google).</li>
  <li>Empresas de reparto, solo con lo necesario para entregar tu pedido.</li>
</ul>
<p>Varios de estos proveedores están fuera del Perú (Estados Unidos, la Unión Europea o Brasil), así que tus datos pueden
transferirse a esos países con el único fin de atenderte.</p>

<h2>6. Cuánto tiempo los guardamos</h2>
<p>Mientras sea necesario para atenderte y para cumplir obligaciones legales, como las tributarias.
Puedes pedir que los eliminemos antes (punto 8).</p>

<h2>7. Tus derechos</h2>
<p>Puedes ejercer tus derechos de acceso, rectificación, cancelación y oposición, y revocar tu consentimiento,
escribiéndonos a <a href="mailto:${NEGOCIO.correo}">${NEGOCIO.correo}</a> o por el mismo WhatsApp.
Te respondemos dentro de los plazos de la Ley N.° 29733. Si no estás conforme con la respuesta, puedes acudir a la
Autoridad Nacional de Protección de Datos Personales del Ministerio de Justicia y Derechos Humanos.</p>

<h2 id="eliminar">8. Cómo eliminar tus datos</h2>
<p>Escríbenos «ELIMINAR MIS DATOS» por WhatsApp, o envía un correo a
<a href="mailto:${NEGOCIO.correo}">${NEGOCIO.correo}</a> con tu número de teléfono.
Borramos tus datos de nuestros sistemas y te confirmamos cuando esté hecho, salvo lo que la ley nos obligue a conservar.</p>

<h2>9. Menores de edad</h2>
<p>Nuestros servicios no están dirigidos a menores de edad.</p>

<h2>10. Cambios</h2>
<p>Si cambiamos esta política, publicaremos aquí la nueva versión con su fecha.</p>`
)

const enviar = (html) => async (req, reply) =>
  reply.code(200).type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(html)

export const paginaInicio = enviar(HTML_INICIO)
export const paginaPrivacidad = enviar(HTML_PRIVACIDAD)
