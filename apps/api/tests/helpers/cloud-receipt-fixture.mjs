// Behavioral fixture: the same predicates as updateMany, including tenant/date.
const equal = (a,b) => a instanceof Date || b instanceof Date ? +new Date(a) === +new Date(b) : a === b
function matches(row, where) {
  return Object.entries(where).every(([k,v]) => {
    if (k === 'OR') return v.some(w => matches(row,w))
    if (k === 'AND') return v.every(w => matches(row,w))
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k])
      if ('lte' in v) return row[k] != null && +new Date(row[k]) <= +new Date(v.lte)
      return matches(row[k] || {},v)
    }
    return equal(row[k] ?? null,v)
  })
}
export const receiptChannel = { resolvedBy:'channel', provider:'cloud', tenantId:'receipt_test', externalKey:'phone-test' }
export const receiptDeps = { resolveChannel: async () => receiptChannel }
export function receiptFixture(initial = []) {
  const messages = initial.map(x => ({id:1, lead:{tenantId:'receipt_test'}, cloudPhoneNumberId:'phone-test', status:null, ...x}))
  const pending = []
  const updates = []
  return { messages,pending,updates,
    message: {
      create: async ({data}) => { const m = {id:messages.length+1,lead:{tenantId:'receipt_test'},createdAt:new Date(),...data};messages.push(m);return m },
      findFirst: async ({where}) => messages.find(m => matches(m,where)) || null,
      updateMany: async ({where,data}) => {updates.push({where,data});const ms=messages.filter(m=>matches(m,where));ms.forEach(m=>Object.assign(m,data));return {count:ms.length}},
    },
    pendingCloudReceipt: {
      create: async ({data}) => {if(pending.some(p=>p.phoneNumberId===data.phoneNumberId && p.waMessageId===data.waMessageId))throw Object.assign(new Error('unique'),{code:'P2002'});pending.push({id:'pending',updatedAt:new Date(),...data})},
      findUnique: async ({where}) => pending.find(p=>matches(p,where.phoneNumberId_waMessageId)) || null,
      findMany: async () => [...pending],
      updateMany: async ({where,data}) => {const ps=pending.filter(p=>matches(p,where));ps.forEach(p=>Object.assign(p,data));return {count:ps.length}},
      deleteMany: async ({where}) => {let count=0;for(let i=pending.length-1;i>=0;i--)if(matches(pending[i],where)){pending.splice(i,1);count++}return {count}},
    }
  }
}
