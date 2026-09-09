/**
 * Electron's ESM loader otherwise opens and parses every small desktop helper
 * before it can create the first window. Bundle only our local modules into one
 * file; runtime packages stay external so optional and lazy imports keep their
 * existing behavior.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [path.join(here, '../src/main.ts')],
  outfile: path.join(here, '../dist/main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  minifySyntax: true,
  minifyWhitespace: true,
  sourcemap: true,
  logLevel: 'warning',
})
