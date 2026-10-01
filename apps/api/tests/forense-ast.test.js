import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { revisarRepo, revisarFuente } from './helpers/commercial-scan.mjs'
const root=fileURLToPath(new URL('../../../',import.meta.url))
test('AST: ningún dato comercial de clientes en código de API, scripts o frontend',()=> assert.deepEqual(revisarRepo(root),[]))
for(const [nombre,fuente] of Object.entries({marca:'const x="HIDATA"',precio:'const x="S/. 139"',comentarioFalso:'const x="https://example.com // BIOAYUR"',concatenacion:'const x="BIO"+"AYUR"',plantilla:'const x=`Hola \u0024{nombre} ELIXIR`',jsx:'const x=<div>Hidata</div>'})) test('AST detecta '+nombre,()=>assert.ok(revisarFuente(fuente,'mutante.tsx').length))
test('AST permite comentarios históricos y rutas JSON, sin excluir archivos',()=>assert.deepEqual(revisarFuente('// BIOAYUR S/.139\nconst p="../data/tenants/bioayur.json"'),[]))

test('AST detecta moneda concatenada a un número literal',()=>assert.ok(revisarFuente('const p="S/"+139').length))
test('AST detecta fórmula comercial en template con constante',()=>assert.ok(revisarFuente('const p=\u0060S/\u0024{139}\u0060').length))
test('AST detecta precio como reemplazo sin eximir todos los replace',()=>assert.ok(revisarFuente('const p="X".replace("X","\u0024139")').length))
