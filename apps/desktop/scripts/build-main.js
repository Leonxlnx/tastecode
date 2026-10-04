/**
 * Electron's ESM loader otherwise opens and parses every small desktop helper
 * before it can create the first window. Bundle only our local modules into one
 * file; runtime packages stay external so optional and lazy imports keep their
 * existing behavior.
 *
 * Splitting keeps each dynamic `import()` of a local module in its own chunk.
 * A single file would hoist that module's package imports (the release
 * updater's electron-updater, semver and zod) into the startup path.
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const outdir = path.join(here, '../dist')

rmSync(path.join(outdir, 'chunks'), { recursive: true, force: true })
await build({
  entryPoints: { main: path.join(here, '../src/main.ts') },
  outdir,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  minifySyntax: true,
  minifyWhitespace: true,
  sourcemap: true,
  logLevel: 'warning',
})
