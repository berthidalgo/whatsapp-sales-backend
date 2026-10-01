import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
test('arranque: imports/exportaciones completos antes de conectar a una BD ficticia',()=>{
  const api=fileURLToPath(new URL('../',import.meta.url))
  const r=spawnSync(process.execPath,['--import','./tests/helpers/offline-guard.mjs','src/server.js'],{
    cwd:api,encoding:'utf8',timeout:15000,
    env:{...process.env,DATABASE_URL:'postgresql://offline:offline@127.0.0.1:1/offline?connect_timeout=1',JWT_SECRET:'offline-test-secret',NODE_ENV:'test',SENTRY_DSN:'',OPENROUTER_API_KEY:'',MISTRAL_API_KEY:''}
  })
  const out=(r.stdout || '')+(r.stderr || '')
  assert.equal(r.error,undefined)
  assert.equal(r.status,1)
  assert.match(out,/P1001/,'Debe resolver TODO el servidor y detenerse solamente en la BD ficticia: '+out)
  assert.doesNotMatch(out,/ERR_MODULE_NOT_FOUND|does not provide an export|SyntaxError/)
})
