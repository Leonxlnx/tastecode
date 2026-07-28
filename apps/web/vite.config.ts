import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative so the built app loads from file:// inside Electron.
  base: './',
  server: { port: 5183, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
})
