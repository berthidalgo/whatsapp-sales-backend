import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Monorepo: el front importa el contrato compartido desde ../shared (una sola
// fuente de verdad del seam back↔front). `fs.allow: ['..']` deja a Vite servir
// archivos fuera de frontend/.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../shared') },
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
})
