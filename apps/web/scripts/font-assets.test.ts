import { copyFile, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { build, type UserConfig } from 'vite'
import { describe, expect, it } from 'vitest'
import config from '../vite.config.js'

const require = createRequire(import.meta.url)

describe('font assets in the production build', () => {
  // index.html's CSP has no font-src, so default-src 'self' blocks data: fonts.
  it('emits a small KaTeX font as a file instead of a data: URL', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tastecode-fonts-')))
    try {
      const font = require.resolve('katex/dist/fonts/KaTeX_Size3-Regular.woff2')
      await copyFile(font, path.join(root, 'KaTeX_Size3-Regular.woff2'))
      await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
      await writeFile(
        path.join(root, 'index.html'),
        '<link rel="stylesheet" href="/style.css"><script type="module" src="/main.js"></script>',
      )
      await writeFile(path.join(root, 'main.js'), 'globalThis.loaded = true')
      await writeFile(
        path.join(root, 'style.css'),
        '@font-face{font-family:Size3;src:url(./KaTeX_Size3-Regular.woff2) format("woff2")}',
      )
      const assetsInlineLimit = (config as UserConfig).build?.assetsInlineLimit
      await build({
        configFile: false,
        root,
        base: './',
        logLevel: 'silent',
        build: assetsInlineLimit === undefined ? {} : { assetsInlineLimit },
      })
      const assets = await readdir(path.join(root, 'dist', 'assets'))
      const css = assets.filter((file) => file.endsWith('.css'))
      expect(css).toHaveLength(1)
      const text = await readFile(path.join(root, 'dist', 'assets', css[0]!), 'utf8')
      expect(text).not.toMatch(/data:(?:font|application\/(?:font|octet-stream|x-font))/)
      expect(assets.some((file) => /^KaTeX_Size3-Regular-.+\.woff2$/.test(file))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
