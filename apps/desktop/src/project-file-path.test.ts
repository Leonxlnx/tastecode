import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { canCreateSymlinks } from '@harness/proc/symlink.test-support'
import { projectFilePath } from './project-file-path.js'

const canSymlink = canCreateSymlinks()

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

  it('rejects a link inside the project that resolves outside it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tastecode-project-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'tastecode-outside-'))
    const secret = path.join(outside, 'secret.txt')
    await writeFile(secret, 'x')
    // A directory junction stands in for the file link on hosts that deny
    // symlinks, so the containment check stays covered on Windows without
    // Developer Mode.
    let link = path.join(root, 'link.txt')
    if (canSymlink) {
      await symlink(secret, link)
    } else {
      await symlink(outside, path.join(root, 'linked'), 'junction')
      link = path.join(root, 'linked', 'secret.txt')
    }
    await expect(projectFilePath(link, root)).rejects.toThrow(/outside/)
    await expect(projectFilePath(secret, root)).rejects.toThrow(/outside/)
  })
})
