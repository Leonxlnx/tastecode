import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative so the built app loads from file:// inside Electron.
  base: './',
  server: {
    // Bind IPv4 explicitly. Vite's default `localhost` resolves to ::1 on
    // Windows, while Electron and the server both use 127.0.0.1 — the window
    // then opens on ERR_CONNECTION_REFUSED and looks like a broken build.
    host: '127.0.0.1',
    port: 5183,
    strictPort: true,
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
