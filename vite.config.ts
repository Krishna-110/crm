import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Lets the ngrok tunnel (a random *.ngrok-free.app / *.ngrok.io host each run) through
    // Vite's Host-header check, which otherwise rejects any host it doesn't recognize.
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.io', '.ngrok.app'],
    proxy: {
      '/api': {
        // Configurable so the Playwright suite can point the app at an API instance running
        // against `medcrm_test` instead of the development database. Without this, every
        // end-to-end test would write into real data — which is exactly what the isolated
        // test database exists to prevent. Unset in normal development, so nothing changes.
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
