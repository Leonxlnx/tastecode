import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { droppedFolderPaths } from './dropped-folder-paths.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('droppedFolderPaths', () => {
  it('keeps one or many folders in drop order and removes duplicates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-folder-drop-'))
    temporaryRoots.push(root)
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    await Promise.all([mkdir(first), mkdir(second)])

    await expect(droppedFolderPaths([first])).resolves.toEqual([first])
    await expect(droppedFolderPaths([first, second, first])).resolves.toEqual([first, second])
  })

  it('ignores files and paths that do not exist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-folder-drop-'))
    temporaryRoots.push(root)
    const folder = path.join(root, 'project')
    const file = path.join(root, 'notes.txt')
    await mkdir(folder)
    await writeFile(file, 'not a project folder')

    await expect(droppedFolderPaths([file, path.join(root, 'missing'), folder])).resolves.toEqual([
      folder,
    ])
  })
})
