import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listWorkspaceDirectory, readWorkspaceTextFile } from './workspace-files.js'

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
})
