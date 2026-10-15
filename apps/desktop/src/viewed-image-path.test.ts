import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PickedImagePaths, viewedImagePath } from './viewed-image-path.js'
import { attachmentPreviewFromUrl, pickedAttachment } from './attachment-preview.js'

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
  it('renews only native-picked external images across renderer reloads and cache eviction', async () => {
    const { root, pasted } = await fixture()
    const picked = path.join(root, 'picked.png')
    const privateFile = path.join(root, 'private.png')
    await writeFile(picked, 'picked')
    await writeFile(privateFile, 'private')
    const grants = new PickedImagePaths()
    await grants.authorize(picked)
    // Renderer state is not needed to renew a main-process authorization.
    for (let attempt = 0; attempt < 2; attempt++) {
      const resolved = await viewedImagePath(picked, pasted, grants)
      expect(resolved).toBe(await realpath(picked))
      const secret = Buffer.alloc(32, attempt + 1)
      const preview = pickedAttachment(resolved!, secret)
      expect(attachmentPreviewFromUrl(preview.previewUrl!, secret)?.path).toBe(resolved)
      expect(preview.thumbnailUrl).toBeDefined()
    }
    await expect(viewedImagePath(privateFile, pasted, grants)).resolves.toBeUndefined()
    await expect(viewedImagePath(picked, pasted, new PickedImagePaths())).resolves.toBeUndefined()
  })

  it('does not widen picked-file grants to directories, siblings or retargeted symlinks', async () => {
    const { root, pasted } = await fixture()
    const picked = path.join(root, 'picked.png')
    const privateFile = path.join(root, 'private.png')
    const link = path.join(root, 'selected.png')
    await writeFile(picked, 'picked')
    await writeFile(privateFile, 'private')
    await symlink(picked, link)
    const grants = new PickedImagePaths()
    await grants.authorize(link)
    await grants.authorize(root)
    await expect(viewedImagePath(link, pasted, grants)).resolves.toBe(await realpath(picked))
    await expect(viewedImagePath(root, pasted, grants)).resolves.toBeUndefined()
    await expect(viewedImagePath(privateFile, pasted, grants)).resolves.toBeUndefined()
    await rm(link)
    await symlink(privateFile, link)
    await expect(viewedImagePath(link, pasted, grants)).resolves.toBeUndefined()
  })

  it('reads durable attachments and falls back to the legacy temporary folder', async () => {
    const { root, pasted } = await fixture()
    const durable = path.join(root, 'app-data', 'pasted-files')
    await mkdir(durable, { recursive: true })
    await writeFile(path.join(durable, 'new.png'), 'new')
    await writeFile(path.join(pasted, 'old.png'), 'old')
    const roots = [durable, pasted]
    await expect(viewedImagePath('new.png', roots)).resolves.toBe(
      await realpath(path.join(durable, 'new.png')),
    )
    await expect(viewedImagePath('old.png', roots)).resolves.toBe(
      await realpath(path.join(pasted, 'old.png')),
    )
    await expect(viewedImagePath('../old.png', roots)).resolves.toBeUndefined()
  })

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
