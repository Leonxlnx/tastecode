#!/usr/bin/env node
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js')

if (!existsSync(cli)) {
  console.error('[harness] Server is not built. Run `pnpm --filter @harness/server build` first.')
  process.exit(1)
}

await import(pathToFileURL(cli).href)
