/**
 * Preload scripts run in a sandboxed context that only supports CommonJS, while
 * the rest of the app is ESM. Rather than split the tsconfig, we compile the one
 * preload file to .cjs here.
 *
 * Node, not a shell script — Windows and macOS both have to run this.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [path.join(here, '../src/preload.ts')],
  outfile: path.join(here, '../dist/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
})
