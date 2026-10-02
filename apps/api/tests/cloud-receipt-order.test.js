import test from 'node:test'
import assert from 'node:assert/strict'
import { aplicarStatus, conciliarRecibosPendientes } from '../src/whatsapp/cloud/statuses.js'
import { persistirMensajeSaliente } from '../src/whatsapp/transporte.js'
import { receiptFixture, receiptDeps, receiptChannel } from './helpers/cloud-receipt-fixture.mjs'
const event = (status,timestamp='1800000000') => ({messageId:'wamid.test',phoneNumberId:'phone-test',status,timestamp})

test('early failed receipt survives until outgoing insert and preserves failure detail',async()=>{
  const db=receiptFixture()
  const r=await aplicarStatus({...event('failed'),errors:[{code:131026,title:'Undeliverable'}]},db,receiptDeps)
  assert.equal(r.pendiente,true);assert.equal(db.pending.length,1)
  await persistirMensajeSaliente(db,{data:{leadId:1,origen:'BOT',texto:'hello'},resultado:{provider:'cloud',messageId:'wamid.test',phoneNumberId:'phone-test'},canal:receiptChannel})
  assert.equal(db.messages[0].status,'failed');assert.equal(db.messages[0].errorCode,131026);assert.equal(db.pending.length,0)
})
test('provider receipts cannot regress read to delivered or sent, including after recovery',async()=>{
  const db=receiptFixture([{waMessageId:'wamid.test',status:'read',statusAt:new Date(1800000000000)}])
  for (const status of ['delivered','sent'])await aplicarStatus(event(status,'1800000001'),db,receiptDeps)
  await conciliarRecibosPendientes(db)
  assert.equal(db.messages[0].status,'read');assert.equal(db.pending.length,0)
})
test('receipt with other phone or tenant never attaches to the existing message',async()=>{
  const db=receiptFixture([{waMessageId:'wamid.test',lead:{tenantId:'other'},status:'sent'}])
  const r=await aplicarStatus(event('read'),db,receiptDeps)
  assert.equal(r.aplicado,false);assert.equal(db.messages[0].status,'sent')
  const no=await aplicarStatus(event('read'),db,{resolveChannel:async()=>({...receiptChannel,externalKey:'wrong'})})
  assert.equal(no.motivo,'canal_no_verificado')
})
test('duplicate callbacks preserve latest provider timestamp and recover after restart',async()=>{
  const db=receiptFixture()
  await aplicarStatus(event('read','1800000010'),db,receiptDeps)
  await aplicarStatus(event('delivered','1800000005'),db,receiptDeps)
  assert.equal(db.pending[0].status,'read')
  db.messages.push({id:2,lead:{tenantId:'receipt_test'},waMessageId:'wamid.test',cloudPhoneNumberId:'phone-test',status:'sent',statusAt:new Date()})
  const r=await conciliarRecibosPendientes(db)
  assert.equal(r.aplicados,1);assert.equal(db.messages[0].status,'read');assert.equal(db.pending.length,0)
})
