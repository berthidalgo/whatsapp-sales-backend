import { readFileSync } from 'node:fs'
export const runtime = Object.freeze(JSON.parse(readFileSync(new URL('../../data/runtime.json',import.meta.url),'utf8')))
