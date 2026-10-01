import { readFileSync } from 'node:fs'
const datos = JSON.parse(readFileSync(new URL('../../data/brain-evals.json',import.meta.url),'utf8'))
export const BRAIN_EVALS = datos.casos
export const BRAIN_EVALS_VERSION = datos.version
