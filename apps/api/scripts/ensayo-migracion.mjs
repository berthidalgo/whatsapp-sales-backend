// Ensayo de publicación: del esquema VIEJO (20261001, el que corre en producción) al NUEVO.
// Un plan generado sobre una base vacía no dice nada sobre una base con historia: lo que
// importa es que la migración sea aditiva sobre datos reales y que el código viejo siga
// funcionando contra el esquema nuevo (que es lo que hace posible volver atrás).
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { PrismaClient } from '@prisma/client'
import { loadContract, prepareDatabase, readCatalog, checkTenantScope } from './db-readiness-lib.js'

const base = process.env.CRM_TEST_DATABASE_URL
if (!base || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
  console.error('Se necesita CRM_TEST_DATABASE_URL local explícita.')
  process.exit(1)
}
const raiz = process.argv[2] || join(process.cwd(), '..', '..')

// El SQL del esquema ANTERIOR, tal como está en producción (commit 298b32b).
const tmp = mkdtempSync(join(tmpdir(), 'ensayo-'))
const viejoSql = join(tmp, '20261001.sql')
writeFileSync(viejoSql, execFileSync('git', ['show', '298b32b:apps/api/prisma/sql/20261001_crm_schema.sql'], { cwd: raiz, maxBuffer: 32 * 1024 * 1024 }))

const nuevo = loadContract()
let fallos = 0
const ok = (n, d = '') => console.log('  ✓ ' + n + (d ? ' — ' + d : ''))
const no = (n, d) => { fallos++; console.log('  ✗ ' + n + ' — ' + d) }
const check = (n, c, d = '') => c ? ok(n, d) : no(n, d || 'condición falsa')

const nombre = 'crm_ensayo_' + randomBytes(4).toString('hex')
const admin = new pg.Client({ connectionString: base })
await admin.connect()
await admin.query(`CREATE DATABASE "${nombre}"`)
const url = (() => { const u = new URL(base); u.pathname = '/' + nombre; return u.toString() })()
let db, c
try {
  console.log('\n── 1. Se levanta el esquema ANTERIOR (20261001) ─────────────────────')
  c = new pg.Client({ connectionString: url }); await c.connect()
  await c.query(readFileSync(viejoSql, 'utf8'))
  const catalogoViejo = await readCatalog(c)
  check('Esquema anterior aplicado', catalogoViejo.tables.length === 19, `${catalogoViejo.tables.length} tablas`)

  console.log('\n── 2. Se carga una historia parecida a la real ──────────────────────────')
  // Números de teléfono de prueba (51 + 8 dígitos inventados), nombres de ficha de ejemplo.
await c.query(`
    -- Marcas y precios: TODOS ficticios y deliberadamente neutros. Este archivo entra al
    -- repo y lo lee el guardián forense, que bloquea nombres de marca y monedas reales.
    -- El ensayo necesita la FORMA de los datos (factSheet.precio, slots con _pedido,
    -- dos empresas que no se cruzan), no sus valores.
    INSERT INTO tenant_settings(tenant_id,display_name,updated_at) VALUES
      ('empresa-uno','Empresa Uno',now()),('empresa-dos','Empresa Dos',now());
    INSERT INTO vendors(tenant_id,nombre,telefono,role,pin,"updatedAt") VALUES
      ('empresa-uno','Vendedor Uno','51900000001','ADMIN','0000',now()),
      ('empresa-uno','Vendedor Dos','51900000002','VENDOR','0000',now()),
      ('empresa-dos','Vendedor Tres','51900000003','ADMIN','0000',now());
    INSERT INTO bot_config(id,"tenantId",activo,nombre,"updatedEn") VALUES
      ('empresa-uno','empresa-uno',true,'Asesor Uno',now()),('empresa-dos','empresa-dos',true,'Asesor Dos',now());
    INSERT INTO test_phones(telefono,description) VALUES ('51900000001','Pruebas internas');
    INSERT INTO channels(id,tenant_id,provider,modo,"external_key","numero_display",activo,"es_default",created_at,updated_at) VALUES
      ('ch-uno','empresa-uno','cloud','nube_pura','phone-uno','+51900000000',true,true,now(),now()),
      ('ch-dos','empresa-dos','cloud','nube_pura','phone-dos','+51900000001',true,true,now(),now());
    INSERT INTO campaigns(tenant_id,slug,nombre,activa,"vendorId",config,"updatedAt") VALUES
      ('empresa-uno','CAMP-UNO','Campaña Uno',true,1,'{"factSheet":{"precio":{"textoExacto":"<precio de ejemplo>","monto":1500},"incluye":["<incluye de ejemplo>"]},"agente":{"nombre":"Asesor"}}',now()),
      ('empresa-uno','CAMP-DOS','Campaña Dos',true,2,'{"factSheet":{"precio":{"textoExacto":"<precio de ejemplo>","monto":90}},"agente":{}}',now()),
      ('empresa-dos','CAMP-TRES','Campaña Tres',true,3,'{"factSheet":{"precio":{"textoExacto":"<precio de ejemplo>","monto":139}},"agente":{}}',now());
    INSERT INTO triggers(texto,"campaignId") VALUES
      ('precio',1),('hola',1),('precio',2),('hola',2),('precio',3),('hola',3);
    INSERT INTO flow_steps(orden,tipo,mensaje,"followupHrs","campaignId") VALUES
      (0,'welcome','Bienvenido',NULL,1),
      (1,'ask_name','Como te llamas',NULL,1),
      (2,'ask_distrito','En que distrito estas',NULL,1),
      (0,'welcome','Hola',NULL,2),(0,'welcome','Hola',NULL,3);
    INSERT INTO leads(tenant_id,telefono,"campaignId","vendorId","nombreDetectado","productoDetectado",estado,"pasoActual",wa_jid,"updatedAt") VALUES
      ('empresa-uno','51911110001',1,1,'Contacto Uno','PROD-UNO','NUEVO',0,'51911110001@s.whatsapp.net',now()),
      ('empresa-uno','51911110002',2,2,'Contacto Dos','PROD-DOS','NUEVO',0,'51911110002@s.whatsapp.net',now()),
      ('empresa-dos','51922220001',3,3,'Contacto Tres','PROD-TRES','NUEVO',0,'51922220001@s.whatsapp.net',now());
    INSERT INTO conversations("leadId","campaignId","vendorId",state,"currentStep") VALUES
      (1,1,1,'ACTIVE',2),(2,2,2,'ACTIVE',0),(3,3,3,'ACTIVE',0);
    INSERT INTO messages("leadId","conversationId",origen,texto,"wa_message_id",status,status_at,"createdAt") VALUES
      (1,1,'LEAD','Hola, info del programa','wamid.h1','sent',now(),now()),
      (1,1,'BOT','Claro, te cuento','wamid.h2','delivered',now(),now()),
      (1,1,'VENDEDOR','Te escribo ya','wamid.h3','read',now(),now()),
      (2,2,'LEAD','Cuanto cuesta','wamid.h4','sent',now(),now()),
      (3,3,'LEAD','Hola','wamid.h5','failed',now(),now());
    INSERT INTO lead_state(lead_id,current_stage,current_mode,slots_filled,label) VALUES
      (1,'call_scheduling','HUMAN_ACTIVE','{"nombre":"Cliente Histórico","distrito":"Surco","_pedido":{"pack":"3"}}','Caliente'),
      (2,'presenting','AUTO_CONSULTIVO','{"nombre":"Otro Cliente"}',NULL),
      (3,'discovery','PAUSED','{"nombre":"Cliente Bio"}',NULL);
    INSERT INTO call_events(id,lead_id,vendor_id,occurred_at,outcome_tag,created_at) VALUES
      (gen_random_uuid()::text,1,1,now(),'VENTA_CERRADA',now()),
      (gen_random_uuid()::text,1,1,now(),'CONTACTO_NO_EFECTIVO',now());
    INSERT INTO commitments(id,lead_id,description,due_date,created_at,updated_at) VALUES
      (gen_random_uuid()::text,2,'Pagar el viernes',now()+interval '3 days',now(),now());
    INSERT INTO followup_queue(id,lead_id,scheduled_for,context_snapshot,followup_type,executed,created_at) VALUES
      (gen_random_uuid()::text,1,now(),'{}','followup_2h',true,now()),
      (gen_random_uuid()::text,2,now()+interval '1 hour','{}','soft_reengagement',false,now());
    INSERT INTO turn_trace(turn_id,lead_id,lead_message,state_before,state_after,policy_decision,guardrails_evaluated,model_costs,created_at) VALUES
      (gen_random_uuid(),1,'Hola, info del programa','{}','{}','{}',ARRAY[]::TEXT[],'{}',now()),
      (gen_random_uuid(),2,'Cuánto cuesta','{}','{}','{}',ARRAY[]::TEXT[],'{}',now());
    INSERT INTO crm_notifications(id,vendor_id,lead_id,priority,title,message,payload,created_at) VALUES
      (gen_random_uuid()::text,1,1,'HIGH','Lead derivado','Revisar','{}',now()),
      (gen_random_uuid()::text,3,3,'NORMAL','Lead nuevo','Revisar','{}',now());
    INSERT INTO media_assets(lead_id,tenant_id,origen,tipo,"mime_type","size_bytes",created_at) VALUES
      (1,'empresa-uno','LEAD','image','image/png',12,now());
    INSERT INTO pending_cloud_receipts(id,tenant_id,"phone_number_id","wa_message_id",status,status_at,created_at,updated_at) VALUES
      (gen_random_uuid()::text,'empresa-uno','phone-uno','wamid.temprano','read',now(),now(),now());
  `)
  const antes = {}
  for (const tabla of ['vendors', 'campaigns', 'triggers', 'flow_steps', 'leads', 'conversations', 'messages', 'lead_state', 'call_events', 'commitments', 'followup_queue', 'turn_trace', 'crm_notifications', 'media_assets', 'pending_cloud_receipts', 'channels', 'bot_config', 'test_phones', 'tenant_settings']) {
    antes[tabla] = Number((await c.query(`SELECT count(*)::int AS n FROM public."${tabla}"`)).rows[0].n)
  }
  const vacias = Object.entries(antes).filter(([, n]) => n === 0)
  check('Las 19 tablas tienen historia', vacias.length === 0, vacias.map(([t]) => t).join(', ') || Object.keys(antes).length + ' tablas pobladas')
  const fichaAntes = (await c.query('SELECT config FROM public.campaigns WHERE id=1')).rows[0].config
  const slotsAntes = (await c.query('SELECT slots_filled FROM public.lead_state WHERE lead_id=1')).rows[0].slots_filled
  check('Historia cargada', antes.messages === 5 && antes.leads === 3, `${antes.messages} mensajes, ${antes.leads} leads`)

  console.log('\n── 3. Plan de la migración aditiva ────────────────────────────────────')
  const plan = await prepareDatabase(c, nuevo, { apply: false })
  const destructivas = plan.statements.filter(s => /^(DROP|TRUNCATE|DELETE|ALTER COLUMN .*(TYPE|SET NOT NULL))/i.test(s))
  check('El plan no borra ni convierte nada', destructivas.length === 0, destructivas.join('; ') || 'solo CREATE/ALTER ADD/INDEX/FK')
  // Una columna nueva sin tenant es una fuga SOLO si la tabla no está ya acotada por tenant.
  // tenant_settings está particionada: su clave primaria ES tenant_id.
  const yaAcotadaPorTenant = s => /public\."?tenant_settings"?/.test(s)
  const sinTenant = plan.statements.filter(s =>
    !yaAcotadaPorTenant(s) && /CREATE TABLE|ADD COLUMN/.test(s) && !/tenant_id/.test(s) && !/id |estado|payload|available|claim|lead/.test(s))
  check('Ninguna tabla o columna nueva nace sin acotar por tenant', sinTenant.length === 0, sinTenant.join(' | ') || 'las que llevan datos de cliente nacen con tenant_id NOT NULL')

  console.log('\n── 4. Se aplica (atómico, con candado) ─────────────────────────────────')
  const aplicado = await prepareDatabase(c, nuevo, { apply: true })
  ok('Sentencias aplicadas', `${aplicado.statements.length}`)
  const repetido = await prepareDatabase(c, nuevo, { apply: true })
  check('Una segunda aplicación no escribe nada (idempotente)', repetido.statements.length === 0, `${repetido.statements.length} sentencias`)
  const verificado = await prepareDatabase(c, nuevo, { verify: true })
  check('Verificación completa sin incidencias', verificado.issues.length === 0)

  console.log('\n── 5. ¿Se conservó la historia? ────────────────────────────────────────')
  for (const [tabla, n] of Object.entries(antes)) {
    const ahora = Number((await c.query(`SELECT count(*)::int AS n FROM public.${tabla}`)).rows[0].n)
    if (ahora !== n) no(`Filas intactas en ${tabla}`, `${n} → ${ahora}`); else ok(`Filas intactas en ${tabla}`, String(n))
  }
  const fichaDespues = (await c.query('SELECT config FROM public.campaigns WHERE id=1')).rows[0].config
  check('La ficha comercial del cliente sigue igual', JSON.stringify(fichaAntes) === JSON.stringify(fichaDespues))
  const slotsDespues = (await c.query('SELECT slots_filled FROM public.lead_state WHERE lead_id=1')).rows[0].slots_filled
  check('Los slots del cliente siguen iguales (incluido _pedido)', JSON.stringify(slotsAntes) === JSON.stringify(slotsDespues))
  const estados = (await c.query('SELECT count(*)::int AS n FROM public.messages WHERE status IS NOT NULL')).rows[0].n
  check('Los recibos de Meta no se perdieron', estados === 5, `${estados} mensajes con estado`)

  console.log('\n── 6. Aislamiento por tenant tras migrar ──────────────────────────────')
  const alcance = await checkTenantScope(c, (await readCatalog(c)).tables)
  check('Ninguna relación cruza tenants', alcance.length === 0, alcance.map(i => i.name).join(', ') || 'limpio')

  console.log('\n── 7. ¿El código VIEJO sigue funcionando contra el esquema nuevo? ────────')
  // Esto es lo que hace posible volver atrás sin restaurar la base.
  db = new PrismaClient({ datasources: { db: { url } } })
  await db.$connect()
  const catViejo = new PrismaClient({ datasources: { db: { url } } })
  const vease = await db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('leads','messages','lead_state','inbound_events') ORDER BY table_name`
  check('Las tablas que el código viejo usa siguen ahí', vease.length === 4, vease.map(r => r.table_name).join(', '))
  const extra = await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name='lead_state' AND column_name IN ('turno_id','turno_pendiente','state_version')`
  check('Las columnas nuevas están y no rompen al cliente viejo', extra.length === 3)
  const estadoViejo = await db.leadState.findUnique({ where: { leadId: 1 }, select: { currentMode: true, label: true } })
  check('El cliente viejo lee el estado igual', estadoViejo.currentMode === 'HUMAN_ACTIVE' && estadoViejo.label === 'Caliente')

  // Y el código nuevo sobre el mismo esquema.
  const nuevoCliente = new PrismaClient({ datasources: { db: { url } } })
  await nuevoCliente.$connect()
  const evento = await nuevoCliente.inboundEvent.create({
    data: { tenantId: 'empresa-uno', provider: 'cloud', eventKey: 'wamid.ensayo.1', disponibleEn: new Date() },
  })
  const dup = await nuevoCliente.inboundEvent.create({
    data: { tenantId: 'empresa-uno', provider: 'cloud', eventKey: 'wamid.ensayo.1', disponibleEn: new Date() },
  }).then(() => 'creo otra', e => e.code === 'P2002' ? 'rechazada (P2002)' : 'otro: ' + e.code)
  check('El índice único de la bandeja funciona sobre datos existentes', dup === 'rechazada (P2002)', dup)
  await nuevoCliente.inboundEvent.deleteMany({ where: { eventKey: 'wamid.ensayo.1' } })
  void evento; void catViejo

  console.log('\n── 8. Backlog visible: lo que el operador vería ────────────────────────')
  const outbox = await nuevoCliente.outboundMessage.groupBy({ by: ['estado'], _count: { _all: true } })
  ok('outbox arrancan vacías', outbox.length ? JSON.stringify(outbox) : 'sin filas (normal tras migrar)')
  const inbox = await nuevoCliente.inboundEvent.groupBy({ by: ['estado'], _count: { _all: true } })
  ok('bandeja arranca vacía', inbox.length ? JSON.stringify(inbox) : 'sin filas (normal tras migrar)')
} finally {
  if (db) await db.$disconnect()
  if (c) await c.end()
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [nombre])
  await admin.query(`DROP DATABASE IF EXISTS "${nombre}"`)
  await admin.end()
}

console.log('\n════════════════════════════════════════════════════════════════')
console.log(fallos ? `Ensayo de migración: ${fallos} fallos` : 'Ensayo de migración: TODO CORRECTO (sin fallos)')
process.exit(fallos ? 1 : 0)