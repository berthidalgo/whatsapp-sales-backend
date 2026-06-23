import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Monorepo (apps/web): importa el contrato compartido desde packages/shared (una
// sola fuente de verdad del seam back↔front). `fs.allow` deja a Vite servir
// archivos fuera de apps/web (la raíz del monorepo, para alcanzar packages/shared).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../../packages/shared') },
  },
  server: {
    port: 5173,
    fs: { allow: ['../..'] },
  },
})
