import test from 'node:test'
import assert from 'node:assert/strict'
import { replyV2, reabrirV2, plantillaReapertura } from '../src/api/inbox-actions.js'
import { resolverCredencialesCloud } from '../src/whatsapp/cloud/config.js'
import { descargarMediaCloud } from '../src/whatsapp/cloud/media.js'
import { saveInboundMedia, MAX_MEDIA_BYTES } from '../src/lib/mediaStore.js'
const user={tenantId:'safety-fixture',vendorId:1,role:'ADMIN'}
const channel={tenantId:user.tenantId,provider:'cloud',externalKey:'phone-fixture',credenciales:{templates:{reapertura:{nombre:'propia',idioma:'es_PE'}}}}
const request=(body={})=>({user,params:{id:1},body})
const reply=()=>({status:200,code(n){this.status=n;return this},send(body){this.body=body;return this}})
test('reply and reopen refuse absent or foreign channels before any paid send',async()=>{
  for(const handler of [replyV2,reabrirV2])for(const canal of [null,{...channel,tenantId:'other'}]){
    const r=reply();let sent=0
    await handler(request({texto:'hello'}),r,{lead:{findFirst:async()=>({id:1,tenantId:user.tenantId,telefono:'1'})}},{defaultChannelForTenant:async()=>canal,sendToWhatsApp:async()=>{sent++},enviarPlantilla:async()=>{sent++}})
    assert.equal(r.status,409);assert.equal(sent,0)
  }
})
test('reopening uses the channel template and language; duplicated request sends once',async()=>{
  let sent=0,marked=false;const messages=[];const states=[]
  const db={lead:{findFirst:async()=>({id:1,tenantId:user.tenantId,telefono:'1',nombreDetectado:'Ana'})},leadState:{upsert:async arg=>states.push(arg)}}
  const deps={defaultChannelForTenant:async()=>channel,checkAndMark:()=>{if(marked)return false;marked=true;return true},invalidarTurnoEnVuelo:()=>{},enviarPlantilla:async args=>{sent++;assert.equal(args.templateName,'propia');assert.equal(args.languageCode,'es_PE');return {ok:true}},persistirMensajeSaliente:async (_db,args)=>{messages.push(args);return {createdAt:new Date()}}}
  let r=reply();await reabrirV2(request(),r,db,deps);assert.equal(r.status,200)
  r=reply();await reabrirV2(request(),r,db,deps);assert.equal(r.status,409);assert.equal(sent,1);assert.equal(messages.length,1);assert.equal(states.length,1)
})
test('24h warning preserves draft and offers only a template owned by that tenant',async()=>{
  const r=reply()
  await replyV2(request({texto:'draft'}),r,{lead:{findFirst:async()=>({id:1,tenantId:user.tenantId,telefono:'1'})}},{defaultChannelForTenant:async()=>channel,sendToWhatsApp:async()=>({ok:false,error:'fuera_de_ventana_24h'})})
  assert.equal(r.status,409);assert.equal(r.body.plantilla,'propia');assert.equal(r.body.textoPendiente,'draft')
  assert.equal(plantillaReapertura({...channel,credenciales:{}},user.tenantId,{CLOUD_TEMPLATE_REAPERTURA:'foreign'}),null)
})
test('Meta credentials never mix another number with the global token',()=>{
  const saved={phone:process.env.CLOUD_PHONE_NUMBER_ID,token:process.env.CLOUD_ACCESS_TOKEN}
  try{process.env.CLOUD_PHONE_NUMBER_ID='global';process.env.CLOUD_ACCESS_TOKEN='global-token'
    assert.equal(resolverCredencialesCloud({phoneNumberId:'other'}).accessToken,null)
    assert.equal(resolverCredencialesCloud({phoneNumberId:'global'}).accessToken,'global-token')
    assert.equal(resolverCredencialesCloud({phoneNumberId:'other',accessToken:'own'}).accessToken,'own')
  }finally{for(const [key,value] of [['CLOUD_PHONE_NUMBER_ID',saved.phone],['CLOUD_ACCESS_TOKEN',saved.token]]){if(value===undefined)delete process.env[key];else process.env[key]=value}}
})
test('media refuses wrong tenant and a message owned by another lead',async()=>{
  let inserts=0
  const db={lead:{findUnique:async()=>({tenantId:'owner'})},message:{findFirst:async()=>null},mediaAsset:{create:async()=>{inserts++;return {id:1}}}}
  const base={leadId:1,tipo:'image',base64:'AAAA'}
  assert.equal((await saveInboundMedia(db,{...base,tenantId:'other'})).error,'tenant_incompatible')
  assert.equal((await saveInboundMedia(db,{...base,tenantId:'owner',messageId:22})).error,'mensaje_incompatible')
  assert.equal(inserts,0)
})
test('media download stops oversized streams before allocating entire file',async()=>{
  const old=globalThis.fetch;let calls=0,reads=0
  try{globalThis.fetch=async()=>{calls++;if(calls===1)return Response.json({url:'http://localhost/media',mime_type:'application/pdf'})
    return new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(MAX_MEDIA_BYTES));if(reads>2)controller.close()}}))}
    const r=await descargarMediaCloud('fixture',{phoneNumberId:'own',accessToken:'own'})
    assert.equal(r.error,'demasiado_grande');assert(reads<=3)
  }finally{globalThis.fetch=old}
})
