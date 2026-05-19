import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// VITE_BACKEND_URL override permite testes E2E apontarem pro backend dedicado
// (porta 3101); dev usa o default 3001.
const BACKEND_URL = process.env.VITE_BACKEND_URL || 'http://localhost:3001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,
    proxy: {
      '/api': BACKEND_URL,
    },
  },
})
