// src/db/prisma.js
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error']
})

export default prisma

// Mismo cliente con nombre: los módulos que aceptan `prisma` como dependencia inyectable
// (bandeja, outbox, tests) importan el nombre en vez del default, para que quede explícito
// que es el cliente real y no un doble accidental.
export { prisma }