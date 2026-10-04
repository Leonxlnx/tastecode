import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { projectFilePath } from './project-file-path.js'

describe('projectFilePath', () => {
  it('accepts Windows and macOS files inside their selected project', async () => {
    await expect(projectFilePath('E:\\work\\site\\src\\index.ts', 'E:\\work\\site')).resolves.toBe(
      'E:\\work\\site\\src\\index.ts',
    )
    await expect(
      projectFilePath('/Users/blue/work/site/src/index.ts', '/Users/blue/work/site'),
    ).resolves.toBe('/Users/blue/work/site/src/index.ts')
  })

  it('rejects traversal, sibling, drive, relative, and network paths', async () => {
    const attempts = [
      () => projectFilePath('E:\\work\\site\\..\\secret.txt', 'E:\\work\\site'),
      () => projectFilePath('E:\\work\\sibling\\secret.txt', 'E:\\work\\site'),
      () => projectFilePath('C:\\work\\site\\secret.txt', 'E:\\work\\site'),
      () => projectFilePath('src\\index.ts', 'E:\\work\\site'),
      () => projectFilePath('\\\\server\\share\\index.ts', 'E:\\work\\site'),
    ]

    for (const attempt of attempts) await expect(attempt()).rejects.toThrow()
  })

  it('expands a stored home-relative project before validating the file', async () => {
    const file = path.join(os.homedir(), 'Developer', 'site', 'src', 'index.ts')
    await expect(projectFilePath(file, '~/Developer/site')).resolves.toBe(file)
    await expect(
      projectFilePath('/tmp/Developer/site/secret.ts', '~/Developer/site'),
    ).rejects.toThrow(/outside/)
  })

  it('rejects a symlink inside the project that resolves outside it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tastecode-project-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'tastecode-outside-'))
    const secret = path.join(outside, 'secret.txt')
    await writeFile(secret, 'x')
    const link = path.join(root, 'link.txt')
    try {
      await symlink(secret, link)
    } catch {
      // Windows without Developer Mode cannot create symlinks — nothing to test.
      return
    }
    await expect(projectFilePath(link, root)).rejects.toThrow(/outside/)
    await expect(projectFilePath(secret, root)).rejects.toThrow(/outside/)
  })
})
