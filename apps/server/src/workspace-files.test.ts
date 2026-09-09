import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareWorkspaceEntries,
  listWorkspaceDirectory,
  readWorkspaceTextFile,
  type WorkspaceFileEntry,
} from './workspace-files.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-workspace-files-'))
  temporary.push(root)
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const answer = 42\n')
  await writeFile(path.join(root, '.env'), 'TOKEN=secret\n')
  return root
}

describe('workspace files', () => {
  it('orders directories first and names in natural numeric order', () => {
    const entry = (name: string, kind: WorkspaceFileEntry['kind']): WorkspaceFileEntry => ({
      name,
      path: name,
      kind,
      size: 0,
      modifiedAt: 0,
      restricted: false,
    })

    expect(
      [entry('file-10', 'file'), entry('folder-2', 'directory'), entry('file-2', 'file')]
        .sort(compareWorkspaceEntries)
        .map(({ name }) => name),
    ).toEqual(['folder-2', 'file-2', 'file-10'])
  })

  it('lists directories first and marks credential paths as restricted', async () => {
    const root = await fixture()
    const result = await listWorkspaceDirectory(root)

    expect(
      result.entries.map(({ name, kind, restricted }) => ({ name, kind, restricted })),
    ).toEqual([
      { name: 'src', kind: 'directory', restricted: false },
      { name: '.env', kind: 'file', restricted: true },
    ])
  })

  it('lists an empty directory and ignores child symlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harness-workspace-empty-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'harness-workspace-linked-file-'))
    temporary.push(root, outside)

    await expect(listWorkspaceDirectory(root)).resolves.toEqual({ path: '', entries: [] })

    const target = path.join(outside, 'target.txt')
    await writeFile(target, 'outside')
    await symlink(target, path.join(root, 'linked.txt'))
    await expect(listWorkspaceDirectory(root)).resolves.toEqual({ path: '', entries: [] })
  })

  it('reads bounded public text and rejects credentials', async () => {
    const root = await fixture()

    await expect(readWorkspaceTextFile(root, 'src/main.ts')).resolves.toMatchObject({
      path: 'src/main.ts',
      binary: false,
      truncated: false,
      content: 'export const answer = 42\n',
    })
    await expect(readWorkspaceTextFile(root, '.env')).rejects.toThrow('credential files')
  })

  it('does not follow a path outside the workspace', async () => {
    const root = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'harness-workspace-outside-'))
    temporary.push(outside)
    await writeFile(path.join(outside, 'outside.txt'), 'outside')
    await symlink(outside, path.join(root, 'linked'))

    await expect(listWorkspaceDirectory(root, 'linked')).rejects.toThrow('path escapes')
    await expect(readWorkspaceTextFile(root, '../outside.txt')).rejects.toThrow('path escapes')
  })

  it('projects nested protocol paths and retains restricted ancestors', async () => {
    const root = await fixture()
    await mkdir(path.join(root, '.git'))
    await writeFile(path.join(root, '.git', 'config'), 'private')

    await expect(listWorkspaceDirectory(root, 'src')).resolves.toMatchObject({
      path: 'src',
      entries: [{ name: 'main.ts', path: 'src/main.ts', restricted: false }],
    })
    await expect(listWorkspaceDirectory(root, '.git')).resolves.toMatchObject({
      path: '.git',
      entries: [{ name: 'config', path: '.git/config', restricted: true }],
    })
  })
})
