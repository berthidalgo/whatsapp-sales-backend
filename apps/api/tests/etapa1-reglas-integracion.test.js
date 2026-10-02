import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pensarYResponder, detectarVulnerabilidadGrave, detectarPideLlamada, aplicarNudgeLlamada } from '../src/brain/agent-brain.js'
import { fusionarSlotsConReglas } from '../src/brain/reglas-etapa1.js'
import { getVertical } from '../src/brain/verticals/index.js'

const exportacion = { vertical:'exportacion', agente:{nombre:'Jhon',nombreProducto:'Mi Primera Exportación'}, factSheet:{casoExito:'Un alumno de 78 años empezó con 1 kg y luego exportó 25 kg.',precio:{textoExacto:'S/ 1500',monto:1500,moneda:'S/'}} }
const tienda = { vertical:'tienda', agente:{nombreProducto:'Mini Parlante X-Pro'}, factSheet:{precio:{textoExacto:'1 unidad S/ 129; 2 unidades S/ 229',monto:129,moneda:'S/'}} }
const colageno = { vertical:'colageno', agente:{nombreProducto:'Colágeno'}, factSheet:{precio:{textoExacto:'S/ 139',monto:139,moneda:'S/'}} }
function args(mensajeActual, config=exportacion, estadoLead={}, historial=[]) {
  return { mensajeActual, campaignConfig:config, estadoLead:{tenantId:config.vertical==='tienda'?'hidata':config.vertical==='colageno'?'bioayur':'peru_exporta',stage:'discovery',slots:{},...estadoLead},historial }
}
async function sinRed(params) {
  const original=globalThis.fetch
  let llamadas=0
  globalThis.fetch=async()=>{llamadas++;throw new Error('RED_PROHIBIDA_EN_PRUEBA')}
  try { const r=await pensarYResponder(params);assert.equal(llamadas,0,'esta regla debe actuar antes de cualquier modelo');assert.equal(r.audit.tokens,0);assert.equal(r.audit.cost_usd,0);return r }
  finally { globalThis.fetch=original }
}
async function modeloSimulado(params, respuesta) {
  const original=globalThis.fetch, base=process.env.OPENAI_COMPAT_BASE_URL
  process.env.OPENAI_COMPAT_BASE_URL='http://127.0.0.1/offline'
  let llamadas=0
  globalThis.fetch=async(url)=>{
    assert.match(String(url),/^http:\/\/127\.0\.0\.1\//)
    llamadas++
    return new Response(JSON.stringify({choices:[{message:{content:typeof respuesta==='string'?respuesta:JSON.stringify(respuesta)}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}),{status:200,headers:{'Content-Type':'application/json'}})
  }
  try { return {r:await pensarYResponder({...params,overrides:{provider:'compat',model:'modelo-falso'}}),llamadas} }
  finally {globalThis.fetch=original;if(base===undefined)delete process.env.OPENAI_COMPAT_BASE_URL;else process.env.OPENAI_COMPAT_BASE_URL=base}
}

for(const texto of ['no estoy endeudado','nunca me endeudé','no vendí mis parcelas, es mi última esperanza','vendí todo mi stock y quiero importar más','vendí mis parcelas para invertir en un negocio','vendí todo y estoy bien','no me queda nada de inventario','me quedé sin nada de stock','no lo perdí todo','no tengo dinero ahora mismo','es mi última esperanza para aprender','estoy endeudado pero puedo pagar']) {
 test(`no deriva una objeción o una negación: ${texto}`,()=>assert.equal(detectarVulnerabilidadGrave(texto),false))
}
for(const texto of ['no tengo ni para comer','no tengo dinero para alimentar a mis hijos','vendí mi casa, es mi última esperanza','estoy endeudada y no puedo pagar mis deudas','no estoy endeudado, pero no tengo ni para comer']) {
 test(`detecta necesidad grave explícita: ${texto}`,()=>assert.equal(detectarVulnerabilidadGrave(texto),true))
}
for(const [vertical,tenantId,defaultCampaign] of [['exportacion','peru_exporta',false],['colageno','bioayur',false],['tienda','hidata',false],['tienda','hidata',true]]) {
 test(`vulnerabilidad precede retornos y modelos en ${tenantId}, default=${defaultCampaign}`,async()=>{
  const r=await sinRed(args('no tengo ni para comer, envío un PDF',{vertical,atribucion:{esCampanaDefault:defaultCampaign}},{tenantId}))
  assert.equal(r.debe_escalar_humano,true);assert.equal(r.audit.model,'regla_vulnerabilidad');assert.doesNotMatch(r.mensaje,/vend|quedarte sin nada|horario|precio|programa|producto/i)
 })
}
for(const texto of ['no quiero que me llamen','no necesito una llamada','no me llames','prefiero por chat','nunca me llamen','no me pueden llamar','no podemos hablar por teléfono','no llames']) {
 test(`respeta rechazo de llamada: ${texto}`,()=>{assert.equal(detectarPideLlamada(texto),false);assert.equal(aplicarNudgeLlamada('P',texto,getVertical(exportacion)),'P')})
}
for(const texto of ['quiero una llamada','podemos hablar por teléfono','puede ser por una llamada','llámame mañana','no me llames hoy, llámame mañana']) {
 test(`detecta solicitud afirmativa de llamada: ${texto}`,()=>assert.equal(detectarPideLlamada(texto),true))
}
for(const modelo of ['openai/gpt-6-luna','google/gemini-3.1-flash-lite','poolside/laguna-s-2.1','ministral-14b-latest']) {
 test(`C023 no depende del modelo ${modelo}`,async()=>{
  const r=await sinRed({...args('Puede ser por una llamada'),overrides:{provider:modelo.includes('ministral')?'mistral':'openrouter',model:modelo}})
  assert.equal(r.stage_sugerido,'call_scheduling');assert.match(r.mensaje,/llamada.*mañana.*10am/s);assert.doesNotMatch(r.mensaje,/cultiv|nombre|empresa|experiencia/i);assert.equal(r.slots_detectados.fecha_hora,undefined)
 })
}
for(const texto of ['me pueden llamar ahorita?','llámame ahora mismo','llámame en 15 minutos']) {
 test(`C057 escala inmediatamente: ${texto}`,async()=>{const r=await sinRed(args(texto));assert.equal(r.debe_escalar_humano,true);assert.equal(r.temperatura_lead,'hot');assert.doesNotMatch(r.mensaje,/mañana|10am|te llamo en 15/i)})
}
test('conserva el día solicitado y no convierte «no ahora» en llamada inmediata',async()=>{
 const r=await sinRed(args('no me llames ahora, llámame mañana a las 11am'))
 assert.equal(r.slots_detectados.fecha_hora,'mañana a las 11am');assert.match(r.mensaje,/confirm.*disponibilidad/i);assert.ok(r.guardrail_flags.includes('llamada_horario_derivado'))
})
test('una propuesta del bot no se guarda como aceptación del lead',async()=>{
 const r=await sinRed(args('quiero una llamada'));assert.equal(r.slots_detectados.fecha_hora,undefined)
})
test('una hora posterior conserva el día que dio el lead',async()=>{
 const r=await sinRed(args('a las 11am',exportacion,{stage:'call_scheduling'},[{rol:'lead',texto:'llámame mañana'},{rol:'agente',texto:'¿A qué hora?'}]))
 assert.equal(r.slots_detectados.fecha_hora,'mañana a las 11am');assert.equal(r.debe_escalar_humano,true)
})
test('las llamadas no cambian las reglas de tienda o colágeno',async()=>{
 for(const config of [tienda,colageno]) { const {r,llamadas}=await modeloSimulado(args('quiero una llamada',config),{mensaje:'Te atiendo por chat.',slots_detectados:{},stage_sugerido:'discovery'});assert.equal(llamadas,1);assert.notEqual(r.audit.proveedor,'regla') }
})
test('rechazo corrige salida válida del modelo y conserva respuesta de precio',async()=>{
 const {r}=await modeloSimulado(args('no quiero que me llamen, dime el precio'),{mensaje:'El precio es S/ 1500. Te llamaré mañana.',stage_sugerido:'call_confirmed',slots_detectados:{fecha_hora:'mañana 10am'},cierre:{ofrecio_llamada:true}})
 assert.match(r.mensaje,/1500/);assert.doesNotMatch(r.mensaje,/llamar/i);assert.equal(r.stage_sugerido,'discovery');assert.equal(r.slots_detectados.fecha_hora,undefined);assert.equal(r.cierre.ofrecio_llamada,false)
})
test('rechazo previo impide volver a ofrecer llamadas en el siguiente turno',async()=>{
 const {r}=await modeloSimulado(args('¿cuánto cuesta?',exportacion,{},[{rol:'lead',texto:'prefiero por chat'}]),{mensaje:'Te llamo hoy a las 4pm.',stage_sugerido:'call_scheduling'})
 assert.doesNotMatch(r.mensaje,/4pm/);assert.ok(r.guardrail_flags.includes('llamada_rechazada'))
})
test('cancelación elimina la cita guardada y deriva al equipo por chat',async()=>{
 const {r}=await modeloSimulado(args('no me llames',exportacion,{stage:'call_confirmed',slots:{fecha_hora:'mañana 10am',nombre:'Rosa'}}),{mensaje:'¿Te llamo mañana?',slots_detectados:{fecha_hora:'hoy 4pm'}})
 assert.equal(r.debe_escalar_humano,true)
 const slots=fusionarSlotsConReglas({fecha_hora:'mañana 10am',nombre:'Rosa'},r.slots_detectados,r.guardrail_flags)
 assert.equal(slots.fecha_hora,undefined);assert.equal(slots.nombre,'Rosa')
})
test('C010 solo comparte evidencia de la ficha, sin aval o personaje inventado',async()=>{
 const r=await sinRed(args('ustedes son una institucion valida? tienen casos de exito?'))
 assert.match(r.mensaje,/78 años/);assert.doesNotMatch(r.mensaje,/avalado por el Estado|don Luis/i);assert.equal(r.debe_escalar_humano,true)
})
test('un aval inventado se neutraliza aunque el modelo produzca JSON válido',async()=>{
 const {r}=await modeloSimulado(args('¿quiénes son ustedes?'),{mensaje:'Somos un programa avalado por el Estado peruano. Nuestro alumno don Luis exportó todo.',stage_sugerido:'discovery'})
 assert.doesNotMatch(r.mensaje,/avalado por el Estado|don Luis/i);assert.ok(r.guardrail_flags.includes('respaldo_no_verificado_neutralizado'))
})
test('un caso real con nombre en la ficha se conserva',async()=>{
 const config={...exportacion,factSheet:{...exportacion.factSheet,casoExito:'El alumno don Luis exportó 25 kg.'}}
 const {r}=await modeloSimulado(args('¿quiénes son ustedes?',config),{mensaje:'El alumno don Luis exportó 25 kg.'})
 assert.match(r.mensaje,/don Luis/);assert.ok(!r.guardrail_flags.includes('respaldo_no_verificado_neutralizado'))
})
for(const modelo of ['openai/gpt-6-luna','google/gemini-3.1-flash-lite','poolside/laguna-s-2.1','ministral-14b-latest']) {
 test(`H07 completa el pedido sin depender de ${modelo}`,async()=>{
  const r=await sinRed({...args('Quiero 2, soy Rosa, vivo en Cayma, Arequipa, Jr. Los Pinos 123',tienda),overrides:{provider:'openrouter',model:modelo}})
  assert.equal(r.debe_escalar_humano,true);assert.equal(r.stage_sugerido,'call_confirmed');assert.match(r.razon_escalamiento,/^PEDIDO:/);assert.equal(r.slots_detectados.cantidad,'2');assert.equal(r.slots_detectados.distrito,'Cayma');assert.equal(r.slots_detectados.ciudad,'Arequipa');assert.equal(r.slots_detectados.direccion,'Jr. Los Pinos 123');assert.doesNotMatch(r.mensaje,/\?|referencia|stock garantizado|S\//)
  assert.ok(getVertical(tienda).detectarVentaCerrada({debeEscalar:r.debe_escalar_humano,razonEscalamiento:r.razon_escalamiento,slots:r.slots_detectados}))
 })
}
for(const texto of ['Quiero 2, soy Rosa, vivo en Cayma','No quiero 2, soy Rosa, vivo en Cayma, Arequipa, Jr. Los Pinos 123','Quiero 2 bicicletas, soy Rosa, vivo en Cayma, Arequipa, Jr. Los Pinos 123','¿Cuánto cuestan 2?']) {
 test(`no inventa un pedido ante datos insuficientes o rechazo: ${texto}`,async()=>{
  const {r,llamadas}=await modeloSimulado(args(texto,tienda),{mensaje:'Revisemos tu consulta.',slots_detectados:{producto:'Mini Parlante X-Pro',cantidad:'2',nombre:'Inventado',direccion:'Otra 99',ciudad:'Lima'}})
  assert.equal(llamadas,1);assert.ok(!r.guardrail_flags.includes('pedido_completo_derivado'))
 })
}
test('completa datos de entrega de un pedido ya solicitado sin exigir referencia',async()=>{
 const r=await sinRed(args('Soy Rosa, vivo en Cayma, Arequipa, Jr. Los Pinos 123',tienda,{stage:'call_scheduling',slots:{cantidad:'2',producto:'Mini Parlante X-Pro'}}))
 assert.equal(r.audit.model,'regla_pedido');assert.equal(r.debe_escalar_humano,true)
})
test('la vulnerabilidad prevalece sobre una solicitud de compra completa',async()=>{
 const r=await sinRed(args('no tengo ni para comer. Quiero 2, soy Rosa, vivo en Cayma, Arequipa, Jr. Los Pinos 123',tienda))
 assert.equal(r.audit.model,'regla_vulnerabilidad');assert.equal(r.temperatura_lead,'cold');assert.deepEqual(r.slots_detectados,{})
})
test('rechazo se mantiene al corregir un precio inventado',async()=>{
 const {r}=await modeloSimulado(args('no quiero llamadas, dime el precio'),{mensaje:'El precio es S/ 999. Te llamo mañana.',stage_sugerido:'call_confirmed',slots_detectados:{fecha_hora:'mañana 10am'}})
 assert.doesNotMatch(r.mensaje,/999|te llamo|mañana/i);assert.equal(r.slots_detectados.fecha_hora,undefined);assert.ok(r.guardrail_flags.includes('llamada_rechazada'))
})
test('una respuesta sin datos actuales no reconfirma un pedido antiguo',async()=>{
 const {r,llamadas}=await modeloSimulado(args('tengo otra consulta',tienda,{stage:'call_scheduling',slots:{cantidad:'2',producto:'Mini Parlante X-Pro',nombre:'Rosa',ciudad:'Arequipa',direccion:'Jr. Los Pinos 123'}}),{mensaje:'Cuéntame tu consulta.'})
 assert.equal(llamadas,1);assert.ok(!r.guardrail_flags.includes('pedido_completo_derivado'))
})
test('la fusión de slots ignora claves que alteren el prototipo',()=>{
 const nuevos=JSON.parse('{"__proto__":"ataque","constructor":"ataque","prototype":"ataque","nombre":"Rosa"}')
 const s=fusionarSlotsConReglas({},nuevos)
 assert.equal(Object.hasOwn(s,'constructor'),false);assert.equal(Object.hasOwn(s,'__proto__'),false);assert.equal(s.nombre,'Rosa')
})
test('un horario con a.m. conserva los datos del lead',async()=>{
 const r=await sinRed(args('llámame mañana a las 11 a.m.'))
 assert.equal(r.slots_detectados.fecha_hora,'mañana a las 11am')
})
test('inventario agotado de café no se trata como pérdida personal',()=>{
 assert.equal(detectarVulnerabilidadGrave('no me queda nada de café'),false)
 assert.equal(detectarVulnerabilidadGrave('no me queda nada de dinero'),true)
})
test('cambio de hora de una cita conserva el día previamente aceptado',async()=>{
 const r=await sinRed(args('a las 11am',exportacion,{stage:'call_confirmed',slots:{fecha_hora:'mañana 10am'}}))
 assert.equal(r.slots_detectados.fecha_hora,'mañana a las 11am');assert.equal(r.debe_escalar_humano,true)
})
test('cambio a llamada inmediata de una cita existente escala sin horario frío',async()=>{
 const r=await sinRed(args('ahorita',exportacion,{stage:'call_confirmed',slots:{fecha_hora:'mañana 10am'}}))
 assert.equal(r.debe_escalar_humano,true);assert.ok(r.guardrail_flags.includes('llamada_inminente_derivada'));assert.doesNotMatch(r.mensaje,/mañana/)
})
test('«ya» dentro de una solicitud futura no adelanta la llamada',async()=>{
 const r=await sinRed(args('ya quiero una llamada mañana a las 11am'))
 assert.ok(r.guardrail_flags.includes('llamada_horario_derivado'));assert.equal(r.slots_detectados.fecha_hora,'mañana a las 11am')
})
test('la preferencia de chat persiste aunque el historial no incluya el rechazo',async()=>{
 const {r}=await modeloSimulado(args('necesito otra consulta',exportacion,{slots:{_canal_contacto:'chat'}}),{mensaje:'Te llamo hoy a las 4pm.',slots_detectados:{_canal_contacto:'llamada',fecha_hora:'hoy 4pm'}})
 assert.ok(r.guardrail_flags.includes('llamada_rechazada'));assert.doesNotMatch(r.mensaje,/4pm/)
 const slots=fusionarSlotsConReglas({_canal_contacto:'chat'},r.slots_detectados,r.guardrail_flags)
 assert.equal(slots._canal_contacto,'chat');assert.equal(slots.fecha_hora,undefined)
})
test('una nueva solicitud expresa permite volver a coordinar una llamada',async()=>{
 const r=await sinRed(args('ahora sí quiero una llamada mañana a las 11am',exportacion,{slots:{_canal_contacto:'chat'}}))
 const slots=fusionarSlotsConReglas({_canal_contacto:'chat'},r.slots_detectados,r.guardrail_flags)
 assert.equal(slots._canal_contacto,'llamada');assert.equal(slots.fecha_hora,'mañana a las 11am')
})
test('el modelo no puede crear preferencias internas ni una marca de pedido',()=>{
 const slots=fusionarSlotsConReglas({_cierre:{intentos:1}},{_canal_contacto:'llamada',_pedido:'confirmado',nombre:'Rosa'},[])
 assert.equal(slots._canal_contacto,undefined);assert.equal(slots._pedido,undefined);assert.deepEqual(slots._cierre,{intentos:1})
})
