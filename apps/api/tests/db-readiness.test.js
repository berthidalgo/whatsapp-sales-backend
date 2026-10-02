import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { API_ROOT, loadContract, selectProfile, compareCatalog, planAdditive, normalizeType, prepareDatabase, parseSchemaSql } from '../scripts/db-readiness-lib.js';

const contract = loadContract();
function catalogFor(c = contract) {
  const catalog = { tables: c.tables.map(t => t.name), columns: [], indexes: [], constraints: [] };
  for (const table of c.tables) {
    for (const col of table.columns) catalog.columns.push({ table: table.name, name: col.name, type: normalizeType(col.type), nullable: col.nullable,
      default: col.default === '__serial__' ? "nextval('fixture_seq'::regclass)" : col.default });
    for (const pk of table.primary) {
      catalog.constraints.push({ table: table.name, name: pk.name, type: 'p', valid: true, columns: pk.columns });
      catalog.indexes.push({ table: table.name, name: pk.name, unique: true, valid: true, method: 'btree', predicate: null, columns: pk.columns });
    }
  }
  for (const index of c.indexes) catalog.indexes.push({ ...index, valid: true, method: 'btree', predicate: null });
  const rule = { CASCADE: 'c', 'SET NULL': 'n', RESTRICT: 'r', 'NO ACTION': 'a' };
  for (const fk of c.foreignKeys) catalog.constraints.push({ ...fk, type: 'f', valid: true, targetSchema: 'public', onDelete: rule[fk.onDelete], onUpdate: rule[fk.onUpdate] });
  return catalog;
}
const empty = () => ({tables: [], columns: [], indexes: [], constraints: []});

test('DB contract covers every CRM model and durable Meta prerequisites', () => {
  // 19 modelos de CRM + los 3 del Hito A (entrada durable, salida durable y candado de
  // followups). El número sale del contrato; lo que se fija aquí es QUÉ tablas existen.
  assert.equal(contract.tables.length, 22);
  for (const name of ['vendors','campaigns','triggers','flow_steps','leads','conversations','messages','media_assets','bot_config','lead_state','turn_trace','call_events','commitments','followup_queue','crm_notifications','test_phones','tenant_settings','channels','pending_cloud_receipts','inbound_events','outbound_messages','followup_reservations']) assert(contract.tables.some(t => t.name === name), name);
  assert.deepEqual(compareCatalog(contract, catalogFor()), []);
  assert(contract.indexes.some(i => i.table === 'pending_cloud_receipts' && i.unique && JSON.stringify(i.columns) === JSON.stringify(['phone_number_id','wa_message_id'])));
  // La deduplicación REAL de la entrada es este índice único, no una marca en memoria:
  // (tenant, proveedor, identidad del evento) es lo que impide duplicar historial y respuesta
  // cuando Meta reentrega el mismo mensaje.
  assert(contract.indexes.some(i => i.table === 'inbound_events' && i.unique && JSON.stringify(i.columns) === JSON.stringify(['tenant_id','provider','event_key'])));
  assert(contract.indexes.some(i => i.table === 'followup_reservations' && i.unique && JSON.stringify(i.columns) === JSON.stringify(['lead_id','followup_type','cycle_key'])));
  // La entrada no se considera procesable hasta que vence la ventana de ráfaga.
  assert(contract.indexes.some(i => i.table === 'inbound_events' && JSON.stringify(i.columns) === JSON.stringify(['estado','disponible_en'])));
  // El turno pendiente y su versión son la base de "qué es hecho y qué es promesa" (Hito A3).
  const ls = contract.tables.find(t => t.name === 'lead_state').columns.map(c => c.name);
  for (const columna of ['turno_id','turno_pendiente','state_version']) assert(ls.includes(columna), columna);
});

test('empty bootstrap has all tables before indexes and FK, no business seeds', () => {
  const plan = planAdditive(contract, empty());
  // El total lo determina el contrato; se comprueba la ESTRUCTURA (tablas primero, claves
  // foráneas al final, nada que borre datos ni inserte semillas de negocio).
  assert.equal(plan.length, contract.tables.length + contract.indexes.length + contract.foreignKeys.length);
  assert(plan.slice(0, 22).every(s => s.startsWith('CREATE TABLE public.')));
  assert(plan.slice(-30).every(s => s.startsWith('ALTER TABLE public.')));
  assert(!plan.some(s => /^(INSERT|DELETE|DROP|TRUNCATE)\b/.test(s)));
});

test('reapplying verified schema is a no-op', () => assert.deepEqual(planAdditive(contract, catalogFor()), []));

test('native time zones and precision are preserved; types are never converted implicitly', () => {
  assert.equal(normalizeType('TIMESTAMPTZ(6)'), normalizeType('timestamp with time zone'));
  assert.equal(normalizeType('TIMESTAMP(6)'), normalizeType('timestamp without time zone'));
  assert.notEqual(normalizeType('TIMESTAMP(3)'), normalizeType('TIMESTAMP(6)'));
  assert.notEqual(normalizeType('TIMESTAMPTZ(6)'), normalizeType('TIMESTAMP(6)'));
  assert.equal(contract.tables.find(t => t.name === 'turn_trace').columns.find(c => c.name === 'turn_id').type, 'UUID');
});

test('a valid historical primary key name remains intact without a redundant primary key', () => {
  const before = catalogFor();
  before.constraints.find(c => c.table === 'leads' && c.type === 'p').name = 'leads_v2_pkey';
  before.indexes.find(i => i.table === 'leads' && i.name === 'leads_pkey').name = 'leads_v2_pkey';
  assert.deepEqual(compareCatalog(contract, before), []);
  assert.deepEqual(planAdditive(contract, before), []);
});

test('legacy message timestamp tightening uses SET NOT NULL without inventing dates', () => {
  const before = catalogFor();
  before.columns.find(c => c.table === 'messages' && c.name === 'createdAt').nullable = true;
  const plan = planAdditive(contract, before);
  assert.deepEqual(plan, ['ALTER TABLE public."messages" ALTER COLUMN "createdAt" SET NOT NULL;']);
  assert(!plan.some(s => /^(UPDATE|DELETE|DROP)/.test(s)));
});

test('upgrade preserves historical tables/data while adding missing Meta objects', () => {
  const before = catalogFor();
  before.tables = before.tables.filter(t => t !== 'pending_cloud_receipts');
  before.columns = before.columns.filter(c => c.table !== 'pending_cloud_receipts' && !(c.table === 'messages' && ['wa_message_id','status','status_at','error_code','error_detalle','cloud_phone_number_id'].includes(c.name)) && !(c.table === 'channels' && c.name === 'modo'));
  before.indexes = before.indexes.filter(i => i.table !== 'pending_cloud_receipts' && !['messages_wa_message_id_key','messages_status_idx'].includes(i.name));
  before.constraints = before.constraints.filter(c => c.table !== 'pending_cloud_receipts');
  const plan = planAdditive(contract, before, before.tables);
  assert(plan.some(s => /CREATE TABLE public\."pending_cloud_receipts"/.test(s)));
  assert(plan.some(s => /ADD COLUMN "cloud_phone_number_id" TEXT/.test(s)));
  assert(plan.some(s => /ADD COLUMN "modo" TEXT NOT NULL DEFAULT 'nube_pura'/.test(s)));
  assert(!plan.some(s => /^(DROP|DELETE|UPDATE|TRUNCATE)\b/.test(s)));
});

test('missing nullable receipt field is detected; no false success', () => {
  const before = catalogFor();
  before.columns = before.columns.filter(c => !(c.table === 'messages' && c.name === 'status'));
  assert(compareCatalog(contract, before).some(i => i.kind === 'missing_column' && i.name === 'status'));
});

test('wrong unique index, invalid index, partial index and wrong key columns fail readiness', () => {
  for (const patch of [{unique:false},{valid:false},{predicate:'status IS NOT NULL'},{columns:['status']},{nullsNotDistinct:true}]) {
    const before = catalogFor();
    Object.assign(before.indexes.find(i => i.name === 'messages_wa_message_id_key'), patch);
    assert.throws(() => planAdditive(contract, before), /índice incompatible/);
  }
});

test('wrong type/nullability/default cannot be silently masked by IF NOT EXISTS', () => {
  for (const patch of [{type:'integer'},{nullable:true},{default:"'other'::text"}]) {
    const before = catalogFor();
    Object.assign(before.columns.find(c => c.table === 'channels' && c.name === 'modo'), patch);
    assert.throws(() => planAdditive(contract, before), /incompatible/);
  }
});

test('forbidden tenant default and FK pointing outside public fail', () => {
  const first = catalogFor();
  first.columns.find(c => c.table === 'vendors' && c.name === 'tenant_id').default = "'legacy'::text";
  assert.throws(() => planAdditive(contract, first), /tenant con default/);
  const second = catalogFor();
  second.constraints.find(c => c.type === 'f').targetSchema = 'foreign';
  assert.throws(() => planAdditive(contract, second), /foreign key incompatible/);
});

test('required missing column on populated table requires explicit backfill', () => {
  const before = catalogFor();
  before.columns = before.columns.filter(c => !(c.table === 'vendors' && c.name === 'tenant_id'));
  assert.throws(() => planAdditive(contract, before, ['vendors']), /sin backfill/);
});

function clientMock(catalog, { ddlFailure = false, locked = true, tenantFailure = false } = {}) {
  const calls = [];
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{locked}] };
    if (sql.includes('format_type')) return {rows: catalog.columns};
    if (sql.includes('FROM pg_index')) return {rows: catalog.indexes};
    if (sql.includes('FROM pg_constraint')) return {rows: catalog.constraints};
    if (sql.startsWith('SELECT c.relname AS name')) return {rows: catalog.tables.map(name => ({name}))};
    if (sql.startsWith('SELECT EXISTS')) return {rows: [{occupied: false}]};
    if (sql.includes('count(*)')) return {rows: [{n: tenantFailure ? 1 : 0}]};
    if (ddlFailure && /^(CREATE|ALTER)/.test(sql)) { const error = new Error('duplicate fixture'); error.code = '23505'; throw error; }
    return {rows: []};
  }};
}

test('any DDL failure rolls back; no commit and no swallowed index error', async () => {
  const db = clientMock(empty(), {ddlFailure: true});
  await assert.rejects(prepareDatabase(db, contract, {apply: true}), /duplicate fixture/);
  assert.equal(db.calls[0], 'BEGIN');
  assert(db.calls.includes('ROLLBACK'));
  assert(!db.calls.includes('COMMIT'));
});

test('advisory lock failure prevents writes', async () => {
  const db = clientMock(catalogFor(), {locked: false});
  await assert.rejects(prepareDatabase(db, contract, {apply: true}), /migración CRM/);
  assert(!db.calls.some(s => /^(CREATE|ALTER)/.test(s)));
  assert(db.calls.includes('ROLLBACK'));
});

test('verification is read-only; missing objects or tenant mismatch fail', async () => {
  const okay = clientMock(catalogFor());
  await prepareDatabase(okay, contract, {verify: true});
  assert.equal(okay.calls[0], 'BEGIN READ ONLY');
  assert(!okay.calls.some(s => /^(CREATE|ALTER|INSERT|DELETE|UPDATE)/.test(s)));
  const missing = clientMock(empty());
  await assert.rejects(prepareDatabase(missing, contract, {verify: true}), /falta tabla/);
  const contaminated = clientMock(catalogFor(), {tenantFailure: true});
  await assert.rejects(prepareDatabase(contaminated, contract, {verify: true}), /relaciones entre tenants/);
});

test('scoped wrappers still validate precise definitions and durable prerequisites', () => {
  assert.deepEqual(selectProfile(contract, 'receipts').tables.map(t => t.name), ['messages','pending_cloud_receipts']);
  assert.deepEqual(selectProfile(contract, 'channel-mode').tables.map(t => t.name), ['channels']);
  assert.throws(() => selectProfile(contract, 'unknown'));
});

test('default CLI does not connect, apply without explicit target fails, invalid args fail', () => {
  const environment = {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot};
  const plan = spawnSync(process.execPath, ['scripts/preparar-db-crm.js'], {cwd: API_ROOT, env: environment, encoding:'utf8'});
  assert.equal(plan.status, 0);
  assert.match(plan.stdout, /sin conexión/);
  const apply = spawnSync(process.execPath, ['scripts/migrar-recibos.js','--aplicar'], {cwd: API_ROOT, env: environment, encoding:'utf8'});
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /CRM_DATABASE_URL requerido/);
  const invalid = spawnSync(process.execPath, ['scripts/migrar-modo-canal.js','--aplicar','--verificar'], {cwd: API_ROOT, env: environment, encoding:'utf8'});
  assert.equal(invalid.status, 1);
});

test('unrecognized SQL fails contract parsing rather than disappearing', () => {
  assert.throws(() => parseSchemaSql('CREATE TABLE public."x" (\n"id" TEXT NOT NULL\n);\nDROP TABLE public."x";\n'), /no reconocidas/);
});
