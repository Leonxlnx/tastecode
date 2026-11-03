import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { restoreMissing, resourcesDirectory } = require('../scripts/after-pack.cjs') as {
  restoreMissing: (source: string, target: string) => Promise<string[]>
  resourcesDirectory: (context: object) => string
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('after-pack default skills', () => {
  it('copies back the files the packager left out and leaves the others alone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tc-after-pack-'))
    roots.push(root)
    const source = path.join(root, 'bundle')
    const target = path.join(root, 'resources', 'default-skills')
    await mkdir(path.join(source, 'skills', 'cinetic', 'public', 'audio'), { recursive: true })
    await writeFile(path.join(source, 'skills', 'cinetic', 'public', 'audio', '.gitkeep'), '')
    await writeFile(path.join(source, 'skills', 'cinetic', 'SKILL.md'), 'source text')
    await mkdir(path.join(target, 'skills', 'cinetic'), { recursive: true })
    await writeFile(path.join(target, 'skills', 'cinetic', 'SKILL.md'), 'packaged text')

    expect(await restoreMissing(source, target)).toEqual([
      path.join('skills', 'cinetic', 'public', 'audio', '.gitkeep'),
    ])
    expect(
      await readFile(path.join(target, 'skills', 'cinetic', 'public', 'audio', '.gitkeep'), 'utf8'),
    ).toBe('')
    expect(await readFile(path.join(target, 'skills', 'cinetic', 'SKILL.md'), 'utf8')).toBe(
      'packaged text',
    )
    expect(await restoreMissing(source, target)).toEqual([])
  })

  it('finds the resources folder on Windows and inside the macOS app bundle', () => {
    const packager = { appInfo: { productFilename: 'Taste Code' } }
    expect(resourcesDirectory({ electronPlatformName: 'win32', appOutDir: 'out', packager })).toBe(
      path.join('out', 'resources'),
    )
    expect(resourcesDirectory({ electronPlatformName: 'darwin', appOutDir: 'out', packager })).toBe(
      path.join('out', 'Taste Code.app', 'Contents', 'Resources'),
    )
  })
})
