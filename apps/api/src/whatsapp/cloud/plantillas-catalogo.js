import { readFileSync } from 'node:fs'
const catalogo = JSON.parse(readFileSync(new URL('../../../data/plantillas-cloud.json',import.meta.url),'utf8')).plantillas
// A custom template never inherits the body of a different approved template.
export function textoDePlantilla(tipo, variables = [], politica = {}) {
  const def = catalogo.find(p => p.nombre === politica.plantilla && p.idioma === politica.idioma)
  const cuerpo = politica.cuerpo || def?.cuerpo
  if (!cuerpo) return '[Plantilla '+(politica.plantilla || tipo)+'; variables: '+JSON.stringify(variables)+']'
  return cuerpo.replace(/\{\{(\d+)\}\}/g, (_,n) => String(variables[Number(n)-1] ?? ''))
}
