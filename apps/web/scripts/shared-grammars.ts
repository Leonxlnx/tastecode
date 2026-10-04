import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'
import type { Plugin } from 'vite'

/**
 * Vite builds the window and worker separately. Bundling the grammar data once
 * lets both realms import the same files without sharing their parser state or
 * loading languages before they are needed.
 */
export function sharedGrammarPlugins(root: string, languages: readonly string[]) {
  const require = createRequire(path.join(root, 'package.json'))
  let assetsDirectory = 'assets'
  let pending: ReturnType<typeof compile> | undefined

  async function compile() {
    const entries = Object.fromEntries(
      languages.map((name) => [name, require.resolve(`@shikijs/langs/${name}`)]),
    )
    const names = new Map(Object.entries(entries).map(([name, file]) => [file, name]))
    const result = await build({
      absWorkingDir: root,
      entryPoints: entries,
      outdir: path.join(root, '.grammar-output'),
      entryNames: 'grammar-[name]-[hash]',
      chunkNames: 'grammar-shared-[hash]',
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      metafile: true,
    })
    const imports = new Map<string, string>()
    for (const [file, metadata] of Object.entries(result.metafile.outputs)) {
      if (!metadata.entryPoint) continue
      const name = names.get(path.resolve(root, metadata.entryPoint))
      if (!name) throw new Error(`Unknown grammar entry: ${metadata.entryPoint}`)
      imports.set(`@shikijs/langs/${name}`, `./${path.basename(file)}`)
    }
    return { imports, files: result.outputFiles, inputs: Object.keys(result.metafile.inputs) }
  }

  const prepare = () => (pending ??= compile())
  const resolver = (): Plugin => ({
    name: 'shared-grammar-imports',
    apply: 'build',
    enforce: 'pre',
    async resolveId(id) {
      if (!id.startsWith('@shikijs/langs/')) return
      const target = (await prepare()).imports.get(id)
      if (!target) throw new Error(`Grammar is missing from the release catalog: ${id}`)
      // Window chunks and worker entries both live in Vite's assets directory.
      return { id: target, external: true }
    },
  })

  const main: Plugin = {
    ...resolver(),
    name: 'shared-grammar-assets',
    configResolved(config) {
      assetsDirectory = config.build.assetsDir
    },
    async buildStart() {
      pending = undefined
      for (const file of (await prepare()).inputs) this.addWatchFile(path.resolve(root, file))
    },
    async generateBundle() {
      for (const file of (await prepare()).files) {
        this.emitFile({
          type: 'asset',
          fileName: path.posix.join(assetsDirectory, path.basename(file.path)),
          source: file.contents,
        })
      }
    },
  }
  return { main, worker: resolver }
}
