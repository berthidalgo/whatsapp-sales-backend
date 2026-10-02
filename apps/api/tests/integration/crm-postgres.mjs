// Explicit integration suite. Only disposable DBs on localhost are allowed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import crypto from 'node:crypto'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { loadContract, prepareDatabase, readCatalog } from '../../scripts/db-readiness-lib.js'
import { aplicarStatus, conciliarRecibosPendientes } from '../../src/whatsapp/cloud/statuses.js'
import { persistirMensajeSaliente } from '../../src/whatsapp/transporte.js'
import { verificarEsquemaCRM } from '../../src/db/readiness.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const apiRoot=join(dirname(fileURLToPath(import.meta.url)),'../..')
const configured=process.env.CRM_TEST_DATABASE_URL
const contract=loadContract()
test('PostgreSQL: migrations and full HTTP CRM contracts', {skip:!configured,timeout:120000}, async t=>{
  const base=new URL(configured)
  assert(['localhost','127.0.0.1','[::1]'].includes(base.hostname),'integration database must be local')
  const suffix=crypto.randomBytes(6).toString('hex')
  const names=['fresh','upgrade','rollback'].map(x=>'crm_smoke_'+x+'_'+suffix)
  const admin=new pg.Client({connectionString:base.toString()});await admin.connect()
  const clients=[];let prisma,server,serverExit
  const urlFor=name=>{const u=new URL(base);u.pathname='/'+name;return u.toString()}
  try{
    for(const name of names){assert(/^crm_smoke_[a-z]+_[a-f0-9]+$/.test(name));await admin.query('CREATE DATABASE "'+name+'"');const c=new pg.Client({connectionString:urlFor(name)});await c.connect();clients.push(c)}
    const [fresh,upgrade,rollback]=clients
    await t.test('empty bootstrap creates every contract model and a second application writes zero statements',async()=>{
      const first=await prepareDatabase(fresh,contract,{apply:true})
      // El número de sentencias lo fija el contrato generado, no el test: se compara contra
      // el propio contrato para que una tabla nueva no rompa la suite sin que nadie lo vea.
      assert.equal(first.statements.length,contract.tables.length+contract.indexes.length+contract.foreignKeys.length)
      const second=await prepareDatabase(fresh,contract,{apply:true});assert.equal(second.statements.length,0)
      assert.deepEqual((await prepareDatabase(fresh,contract,{verify:true})).issues,[])
      assert.equal(contract.tables.length,22)
    })
    await t.test('additive upgrade preserves commercial ficha, lead state and messages',async()=>{
      await prepareDatabase(upgrade,contract,{apply:true})
      await upgrade.query(`INSERT INTO vendors(tenant_id,nombre,telefono,"updatedAt") VALUES('fixture','operator','1',now());
        INSERT INTO campaigns(tenant_id,slug,nombre,"vendorId",config,"updatedAt") VALUES('fixture','F','Fixture',1,'{"factSheet":{"precio":{"textoExacto":"S/ 91"}}}',now());
        INSERT INTO leads(tenant_id,telefono,"campaignId","vendorId","updatedAt") VALUES('fixture','2',1,1,now());
        INSERT INTO messages("leadId",origen,texto) VALUES(1,'LEAD','historic message');
        INSERT INTO lead_state(lead_id,slots_filled) VALUES(1,'{"nombre":"historic"}');
        DROP TABLE pending_cloud_receipts;
        ALTER TABLE messages DROP COLUMN cloud_phone_number_id, DROP COLUMN status, DROP COLUMN status_at, DROP COLUMN error_code, DROP COLUMN error_detalle, DROP COLUMN wa_message_id;
        ALTER TABLE channels DROP COLUMN modo;`)
      await upgrade.query('ALTER TABLE leads RENAME CONSTRAINT leads_pkey TO leads_v2_pkey; ALTER TABLE messages ALTER COLUMN "createdAt" DROP NOT NULL')
      const result=await prepareDatabase(upgrade,contract,{apply:true});assert(result.statements.length>0)
      assert.equal((await upgrade.query('SELECT texto FROM messages')).rows[0].texto,'historic message')
      assert.equal((await upgrade.query('SELECT slots_filled FROM lead_state')).rows[0].slots_filled.nombre,'historic')
      assert.equal((await upgrade.query('SELECT config FROM campaigns')).rows[0].config.factSheet.precio.textoExacto,'S/ 91')
    })
    await t.test('tenant mismatch rolls back every DDL change and preserves existing rows',async()=>{
      await prepareDatabase(rollback,contract,{apply:true})
      await rollback.query(`INSERT INTO vendors(tenant_id,nombre,telefono,"updatedAt") VALUES('one','operator','1',now());
        INSERT INTO campaigns(tenant_id,slug,nombre,"vendorId","updatedAt") VALUES('two','F','Fixture',1,now());
        ALTER TABLE lead_state DROP COLUMN label;`)
      await assert.rejects(()=>prepareDatabase(rollback,contract,{apply:true}),/campaign_vendor/)
      assert(!(await readCatalog(rollback)).columns.some(c=>c.table==='lead_state' && c.name==='label'))
      assert.equal((await rollback.query('SELECT count(*)::int AS n FROM vendors')).rows[0].n,1)
      await rollback.query('CREATE INDEX "messages_wa_message_id_key_wrong" ON messages(status)')
      await rollback.query('DROP INDEX messages_wa_message_id_key; ALTER INDEX messages_wa_message_id_key_wrong RENAME TO messages_wa_message_id_key')
      await assert.rejects(()=>prepareDatabase(rollback,contract,{apply:true}),/índice incompatible/)
    })

    prisma=new PrismaClient({datasources:{db:{url:urlFor(names[0])}}})
    await prisma.$connect()
    for(const tenantId of ['one','two'])await prisma.tenantSettings.create({data:{tenantId,displayName:tenantId}})
    const va=await prisma.vendor.create({data:{tenantId:'one',nombre:'Alpha',telefono:'11',role:'ADMIN'}})
    const vb=await prisma.vendor.create({data:{tenantId:'one',nombre:'Beta',telefono:'12'}})
    const vc=await prisma.vendor.create({data:{tenantId:'two',nombre:'Other',telefono:'13',role:'ADMIN'}})
    const cfg={vertical:'tienda',agente:{nombre:'Asesor',empresa:'Empresa de prueba'},factSheet:{precio:{textoExacto:'S/ 139',monto:139,moneda:'S/'},incluye:['Entrega'],imagenes:{}}}
    const ca=await prisma.campaign.create({data:{tenantId:'one',vendorId:va.id,slug:'A',nombre:'A',config:cfg,triggers:{create:{texto:'pack 3'}}}})
    const ca2=await prisma.campaign.create({data:{tenantId:'one',vendorId:va.id,slug:'A2',nombre:'A2',config:cfg,triggers:{create:{texto:'other'}}}})
    const cb=await prisma.campaign.create({data:{tenantId:'one',vendorId:vb.id,slug:'B',nombre:'B',config:cfg,triggers:{create:{texto:'next'}}}})
    const cc=await prisma.campaign.create({data:{tenantId:'two',vendorId:vc.id,slug:'C',nombre:'C',config:cfg}})
    const la=await prisma.lead.create({data:{tenantId:'one',vendorId:va.id,campaignId:ca.id,telefono:'21'}})
    const lb=await prisma.lead.create({data:{tenantId:'one',vendorId:vb.id,campaignId:cb.id,telefono:'22'}})
    const lc=await prisma.lead.create({data:{tenantId:'two',vendorId:vc.id,campaignId:cc.id,telefono:'23'}})
    const channel=await prisma.channel.create({data:{tenantId:'one',provider:'cloud',externalKey:'phone-test',esDefault:true,credenciales:{templates:{reapertura:{nombre:'fixture',idioma:'es'}}}}})
    const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r))
    const jwtSecret=crypto.randomBytes(32).toString('hex')
    const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:urlFor(names[0]),JWT_SECRET:jwtSecret,DOTENV_CONFIG_PATH:join(apiRoot,'tests','fixture-no-env-file'),OPENROUTER_API_KEY:'',MISTRAL_API_KEY:'',GOOGLE_API_KEY:'',GEMINI_API_KEY:'',CLOUD_ACCESS_TOKEN:'',EVOLUTION_API_KEY:''}
    server=spawn(process.execPath,[join(apiRoot,'src/server.js')],{cwd:apiRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});serverExit=once(server,'exit');let output='';server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d)
    const baseHttp='http://127.0.0.1:'+port
    const token=claims=>{const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const p=Buffer.from(JSON.stringify({...claims,exp:Math.floor(Date.now()/1000)+300})).toString('base64url');return h+'.'+p+'.'+crypto.createHmac('sha256',jwtSecret).update(h+'.'+p).digest('base64url')}
    const a=token({tenantId:'one',vendorId:va.id,role:'ADMIN'}),b=token({tenantId:'one',vendorId:vb.id,role:'VENDOR'}),c=token({tenantId:'two',vendorId:vc.id,role:'ADMIN'})
    for(let i=0;i<100;i++){try{if((await fetch(baseHttp+'/health')).ok)break}catch{}if(server.exitCode!==null)assert.fail('server failed: '+output.slice(-1200));await new Promise(r=>setTimeout(r,100))}
    const request=async(path,{method='GET',body,auth=a}={})=>{const r=await fetch(baseHttp+path,{method,headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}}
    await t.test('real JWT guard rejects missing tenant and restricts admin endpoints',async()=>{
      assert.equal((await request('/ready')).body.database.ready,true)
      assert.equal((await request('/v2/leads',{auth:token({vendorId:va.id,role:'ADMIN'})})).status,401)
      assert.equal((await request('/v2/agent-config?campaignId='+ca.id,{auth:b})).status,403)
      for(const id of ['bad','0','2147483648'])assert.equal((await request('/v2/leads/'+id)).status,400)
      assert.equal((await request('/v2/leads/'+la.id+'/reply',{method:'POST',body:{texto:42}})).status,400)
    })
    await t.test('lead, campaign and media reads do not cross tenant or vendor boundaries',async()=>{
      const ids=(await request('/v2/leads',{auth:b})).body.map(x=>x.id);assert.deepEqual(ids,[lb.id])
      for(const path of ['/v2/leads/'+lc.id,'/v2/leads/'+lc.id+'/conversation','/v2/campaigns/'+cc.id])assert.equal((await request(path)).status,404)
      assert.equal((await request('/v2/leads/'+la.id,{auth:b})).status,404)
      const md=await prisma.mediaAsset.create({data:{leadId:lc.id,tenantId:'two',tipo:'image',mimeType:'image/png',bytes:Buffer.from('fixture')}})
      assert.equal((await request('/v2/leads/'+la.id+'/media/'+md.id)).status,404)
    })
    await t.test('ficha saves merge nested fields, reject stale writers and prohibit active deletion',async()=>{
      const uri='/v2/agent-config';let result=await request(uri,{method:'PUT',body:{campaignId:ca.id,version:1,factSheet:{precio:{textoExacto:'S/ 129',monto:129}}}});assert.equal(result.status,200)
      const stored=(await prisma.campaign.findUnique({where:{id:ca.id}})).config;assert.equal(stored.factSheet.precio.moneda,'S/');assert.deepEqual(stored.factSheet.incluye,['Entrega'])
      result=await request(uri,{method:'PUT',body:{campaignId:ca.id,version:1,factSheet:{incluye:['stale']}}});assert.equal(result.status,409);assert.equal(result.body.version,2)
      result=await request(uri,{method:'PUT',body:{campaignId:ca.id,version:2,factSheet:null}});assert.equal(result.status,409)
      result=await request(uri,{method:'PUT',body:{campaignId:ca.id,version:2,factSheet:null,force:true}});assert.equal(result.status,400)
      assert.equal((await request(uri,{method:'PUT',body:{campaignId:cc.id,version:1,factSheet:{incluye:['foreign']}}})).status,404)
      assert.equal((await request(uri,{method:'PUT',body:{campaignId:0,version:1,factSheet:{incluye:['bad']}}})).status,400)
      const preview=await request(uri+'/preview',{method:'POST',body:{campaignId:ca.id,factSheet:{precio:{textoExacto:'S/ 199',monto:99}}}});assert.equal(preview.body.ok,false)
    })
    await t.test('activation changes only campaigns owned by the selected vendor',async()=>{
      assert.equal((await request('/campaigns/'+ca.id+'/activar',{method:'PATCH'})).status,200)
      assert.equal((await prisma.campaign.findUnique({where:{id:ca2.id}})).activa,false)
      assert.equal((await prisma.campaign.findUnique({where:{id:cb.id}})).activa,true)
      assert.equal((await prisma.campaign.findUnique({where:{id:cc.id}})).activa,true)
    })
    await t.test('unified cursor traverses every event once even at identical timestamps',async()=>{
      const at=new Date('2026-01-01T00:00:00.000Z')
      for(let i=0;i<4;i++)await prisma.message.create({data:{leadId:la.id,origen:'LEAD',texto:'message '+i,createdAt:at}})
      for(let i=0;i<4;i++)await prisma.crmNotification.create({data:{vendorId:va.id,leadId:la.id,priority:'HIGH',title:'state '+i,message:'fixture',createdAt:at}})
      for(let i=0;i<3;i++)await prisma.mediaAsset.create({data:{leadId:la.id,tenantId:'one',tipo:'image',mimeType:'image/png',createdAt:at}})
      const ids=[];let before=null;let page
      do{const result=await request('/v2/leads/'+la.id+'/conversation?limit=2'+(before?'&before='+encodeURIComponent(before):''));assert.equal(result.status,200);ids.push(...result.body.eventos.map(e=>e.id));page=result.body.page;before=page.cursor}while(page.hayMas)
      assert.equal(ids.length,11);assert.equal(new Set(ids).size,11)
      assert.equal((await request('/v2/leads/'+la.id+'/conversation?before=c1.invalid')).status,400)
    })
    await t.test('durable early receipt attaches after insert and never regresses read',async()=>{
      const verified={...channel,resolvedBy:'channel'};const deps={resolveChannel:async()=>verified}
      const ev={messageId:'wamid.early',phoneNumberId:'phone-test',status:'read',timestamp:'1800000000'}
      assert.equal((await aplicarStatus(ev,prisma,deps)).pendiente,true)
      const m=await persistirMensajeSaliente(prisma,{data:{leadId:la.id,origen:'BOT',texto:'reply'},resultado:{provider:'cloud',messageId:ev.messageId,phoneNumberId:'phone-test'},canal:verified})
      assert.equal((await prisma.message.findUnique({where:{id:m.id}})).status,'read')
      await aplicarStatus({...ev,status:'delivered',timestamp:'1800000001'},prisma,deps)
      await conciliarRecibosPendientes(prisma)
      assert.equal((await prisma.message.findUnique({where:{id:m.id}})).status,'read')
      assert.equal(await prisma.pendingCloudReceipt.count(),0)
      const foreign=await prisma.message.create({data:{leadId:lc.id,origen:'BOT',texto:'foreign',waMessageId:'wamid.foreign',cloudPhoneNumberId:'phone-test',status:'sent'}})
      assert.equal((await aplicarStatus({...ev,messageId:foreign.waMessageId},prisma,deps)).aplicado,false)
      assert.equal((await prisma.message.findUnique({where:{id:foreign.id}})).status,'sent')
    })
    await t.test('boot gate rejects an incomplete schema without automatic DDL',async()=>{
      await fresh.query('ALTER TABLE lead_state DROP COLUMN label')
      await assert.rejects(()=>verificarEsquemaCRM(prisma),e=>e.code==='CRM_SCHEMA_NOT_READY')
      assert(!(await readCatalog(fresh)).columns.some(x=>x.table==='lead_state' && x.name==='label'))
    })
  } finally{
    if(server && server.exitCode===null){server.kill();await serverExit}
    if(prisma)await prisma.$disconnect()
    for(const c of clients)await c.end()
    for(const name of names){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admin.query('DROP DATABASE IF EXISTS "'+name+'"')}
    await admin.end()
  }
})
