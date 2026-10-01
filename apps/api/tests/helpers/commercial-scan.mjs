import ts from 'typescript'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
// No source-file exemptions. Only data resource paths, comments and test fixtures are outside this gate.
const dir = new URL('../../data/tenants/',import.meta.url)
const palabras = new Set()
for (const archivo of readdirSync(dir).filter(f=>f.endsWith('.json'))) {
  const d = JSON.parse(readFileSync(new URL(archivo,dir),'utf8'))
  palabras.add(d.tenant.tenantId)
  for (const alias of d.gateMarcas || []) palabras.add(alias)
  for (const v of d.vendors) palabras.add(v.nombre)
  for (const c of d.campaigns) for (const campo of ['nombre','empresa','nombreProducto']) {
    const valor=c.config?.agente?.[campo]
    if (valor) palabras.add(valor)
  }
}
const escapar = s => s.replace(/[.*+?^\u0024{}()|[\]\\]/g,'\\\u0024&')
const patrones = [...palabras].map(s=>escapar(s.normalize('NFD').replace(/[\u0300-\u036f]/g,'')).replace(/[_ -]+/g,'[ _-]+'))
const marca = new RegExp('\\b(?:'+patrones.join('|')+')\\b','i')
const precio = /(?:s\/\.?\s*\d|\$\s*\d|\b\d[\d.,]*\s*(?:soles?|pen|usd|d[oó]lares?)\b)/i
function constante(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return n.text
  if (ts.isParenthesizedExpression(n)) return constante(n.expression)
  if (ts.isTemplateExpression(n)) {
    let valor=n.head.text
    for(const p of n.templateSpans) { const v=constante(p.expression); if(v===null)return null; valor+=v+p.literal.text }
    return valor
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = constante(n.left), b = constante(n.right)
    return a !== null && b !== null ? a+b : null
  }
  return null
}
export function revisarFuente(fuente, archivo = 'input.js') {
  const ast = ts.createSourceFile(archivo,fuente,ts.ScriptTarget.Latest,true,archivo.endsWith('x') ? ts.ScriptKind.TSX : archivo.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  const fallos = []
  const recursos = /^(?:\.{1,2}\/)*[a-zA-Z0-9_./-]+\.json$/
  function evaluar(texto,n) {
    if (!texto || recursos.test(texto)) return
    let monetario = texto
    let p = n.parent
    while (p && !ts.isSourceFile(p)) {
      if ((ts.isCallExpression(p) && /(?:\.query|\.\$queryRawUnsafe)$/.test(p.expression.getText(ast))) || (ts.isCallExpression(p) && /\.replace$/.test(p.expression.getText(ast)) && /^\$[1-9](?:\$[1-9]|[a-z])*$/i.test(texto))) { monetario = texto.replace(/\$\d+/g,''); break }
      p = p.parent
    }
    if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(texto)) monetario = texto.replace(/\$\d+/g,'')
    if (marca.test(texto.normalize('NFD').replace(/[\u0300-\u036f]/g,'')) || precio.test(monetario)) {
      const pos = ast.getLineAndCharacterOfPosition(n.getStart(ast))
      fallos.push({ archivo, linea: pos.line+1, texto: texto.slice(0,120) })
    }
  }
  function visitar(n) {
    const v = constante(n)
    if (v !== null) evaluar(v,n)
    else if (ts.isTemplateExpression(n)) {
      evaluar(n.head.text,n.head)
      n.templateSpans.forEach(p => evaluar(p.literal.text,p.literal))
    } else if (ts.isJsxText(n)) evaluar(n.text,n)
    ts.forEachChild(n,visitar)
  }
  visitar(ast)
  for (const d of ast.parseDiagnostics) fallos.push({archivo,linea:ast.getLineAndCharacterOfPosition(d.start).line+1,texto:'Sintaxis: '+ts.flattenDiagnosticMessageText(d.messageText,' ')})
  return fallos
}
export function revisarRepo(root) {
  const fallos=[]
  function walk(dir) {
    for (const e of readdirSync(dir,{withFileTypes:true})) {
      const p=join(dir,e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(?:js|mjs|cjs|ts|tsx)$/.test(e.name)) fallos.push(...revisarFuente(readFileSync(p,'utf8'),relative(root,p)))
    }
  }
  for (const dir of ['apps/api/src','apps/api/scripts','apps/api/prisma','apps/web/src','packages/shared']) walk(join(root,dir))
  return fallos
}
