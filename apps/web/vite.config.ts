import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { sharedGrammarPlugins } from './scripts/shared-grammars.js'
import { shippedLanguageNames } from './src/ui/shiki-languages.js'

const harnessServerUrl = process.env['VITE_HARNESS_SERVER_URL'] ?? 'ws://127.0.0.1:4311'
const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
const grammarPlugins = sharedGrammarPlugins(here('.'), shippedLanguageNames)

export default defineConfig({
  resolve: {
    // Dependencies (notably @pierre/diffs) import the full `shiki` entry, which
    // registers every grammar plus the Oniguruma WASM engine. Point them at the
    // curated catalog the app's own highlighter uses so a single set of grammar
    // chunks is shipped and the WASM binary the CSP forbids is never emitted.
    alias: [
      { find: /^shiki$/, replacement: here('./src/ui/shiki-bundle.ts') },
      { find: /^shiki\/wasm$/, replacement: here('./src/ui/shiki-wasm.ts') },
    ],
  },
  plugins: [
    react(),
    grammarPlugins.main,
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
  worker: { format: 'es', plugins: () => [grammarPlugins.worker()] },
  test: {
    // Vitest hands node_modules to Node untouched, which would let @pierre/diffs
    // reach the real `shiki` entry and silently bypass the alias under test.
    server: { deps: { inline: ['@pierre/diffs'] } },
  },
})
