import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { viewedImagePath } from './viewed-image-path.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-viewed-image-'))
  temporaryDirectories.push(root)
  const pasted = path.join(root, 'TasteCode', 'pasted-files')
  await mkdir(pasted, { recursive: true })
  return { root, pasted }
}

describe('viewed image paths', () => {
  it('resolves pasted-image references retained in old and current transcripts', async () => {
    const { pasted } = await fixture()
    const pastedImage = path.join(pasted, 'uuid-pasted.png')
    await writeFile(pastedImage, 'pasted')

    await expect(viewedImagePath('uuid-pasted.png', pasted)).resolves.toBe(
      await realpath(pastedImage),
    )
  })

  it('rejects absolute paths, traversal, and symlinks that leave the paste folder', async () => {
    const { root, pasted } = await fixture()
    const outside = path.join(root, 'outside.png')
    await writeFile(outside, 'private')
    await symlink(outside, path.join(pasted, 'linked.png'))

    await expect(viewedImagePath(outside, pasted)).resolves.toBeUndefined()
    await expect(viewedImagePath('../outside.png', pasted)).resolves.toBeUndefined()
    await expect(viewedImagePath('linked.png', pasted)).resolves.toBeUndefined()
  })
})
