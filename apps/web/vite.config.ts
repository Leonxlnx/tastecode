import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const harnessServerUrl = process.env['VITE_HARNESS_SERVER_URL'] ?? 'ws://127.0.0.1:4311'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'harness-content-security-policy',
      transformIndexHtml(html) {
        return html.replace('__HARNESS_SERVER_ORIGIN__', new URL(harnessServerUrl).origin)
      },
    },
  ],
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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // The shell's shared modules used to become ten tiny startup chunks.
        // Keep the initial graph together while preserving every lazy feature
        // boundary, which removes file reads and module handoffs at launch.
        codeSplitting: { groups: [{ name: 'startup', tags: ['$initial'] }] },
      },
    },
  },
  // Module workers keep Shiki's language imports split instead of packing the
  // complete grammar catalog into one multi-megabyte worker entry.
  worker: { format: 'es' },
})
