import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { shippedLanguageNames } from '../src/ui/shiki-languages.js'
import { sharedGrammarPlugins } from './shared-grammars.js'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(path.join(webRoot, 'package.json'))

describe('shared release grammars', () => {
  it('ships each language once with its exact original data and resolvable imports', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tastecode-grammars-')))
    try {
      await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
      await writeFile(
        path.join(root, 'index.html'),
        '<script type="module" src="/main.js"></script>',
      )
      const loaders = shippedLanguageNames
        .map((name) => `${JSON.stringify(name)}: () => import('@shikijs/langs/${name}')`)
        .join(',')
      await writeFile(
        path.join(root, 'main.js'),
        `globalThis.grammars = {${loaders}}; globalThis.worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});`,
      )
      await writeFile(path.join(root, 'worker.js'), `globalThis.grammars = {${loaders}};`)
      const plugins = sharedGrammarPlugins(webRoot, shippedLanguageNames)
      await build({
        configFile: false,
        root,
        base: './',
        logLevel: 'silent',
        plugins: [plugins.main],
        worker: { format: 'es', plugins: () => [plugins.worker()] },
        build: { assetsDir: 'assets/syntax' },
      })
      const directory = path.join(root, 'dist', 'assets', 'syntax')
      const files = await readdir(directory)
      for (const name of shippedLanguageNames) {
        const entries = files.filter((file) =>
          new RegExp(`^grammar-${name}-[A-Z0-9]+\\.js$`).test(file),
        )
        expect(entries, name).toHaveLength(1)
        const original = await import(
          /* @vite-ignore */ pathToFileURL(require.resolve(`@shikijs/langs/${name}`)).href
        )
        const bundled = await import(
          /* @vite-ignore */ pathToFileURL(path.join(directory, entries[0]!)).href
        )
        expect(bundled.default, name).toEqual(original.default)
      }
      // These are compiler-produced static/dynamic imports, not arbitrary user text.
      let consumers = 0
      for (const file of files.filter((name) => name.endsWith('.js'))) {
        const code = await readFile(path.join(directory, file), 'utf8')
        const imports = [...code.matchAll(/(?:from\s*|import\s*\(?)[`"'](\.\/[^`"']+\.js)[`"']/g)]
        for (const [, target] of imports) {
          expect(files, `${file} -> ${target}`).toContain(path.basename(target!))
        }
        if (/^(index|worker)-/.test(file)) {
          consumers++
          expect(imports.filter(([, target]) => target!.startsWith('./grammar-'))).toHaveLength(
            shippedLanguageNames.length,
          )
        }
      }
      expect(consumers).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
