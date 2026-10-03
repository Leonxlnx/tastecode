import { mkdtemp, mkdir, opendir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareWorkspaceEntries,
  listWorkspaceDirectory,
  readWorkspaceTextFile,
  searchWorkspaceFiles,
  type WorkspaceFileEntry,
} from './workspace-files.js'

const temporary: string[] = []

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, opendir: vi.fn(actual.opendir) }
})

afterEach(async () => {
  vi.mocked(opendir).mockReset()
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

  it('finds unopened descendants by case-insensitive name and relative path', async () => {
    const root = await fixture()
    await mkdir(path.join(root, 'src', 'components'))
    await writeFile(path.join(root, 'src', 'components', 'Widget.tsx'), 'export {}')

    await expect(searchWorkspaceFiles(root, '  WIDGET  ')).resolves.toMatchObject({
      entries: [{ name: 'Widget.tsx', path: 'src/components/Widget.tsx', restricted: false }],
      truncated: false,
    })
    await expect(searchWorkspaceFiles(root, 'SRC/COMPONENTS')).resolves.toMatchObject({
      entries: [
        { name: 'components', path: 'src/components', kind: 'directory' },
        { name: 'Widget.tsx', path: 'src/components/Widget.tsx', kind: 'file' },
      ],
      truncated: false,
    })
    await expect(searchWorkspaceFiles(root, 'no-such-name')).resolves.toEqual({
      entries: [],
      truncated: false,
    })
  })

  it('shares listing visibility, metadata and restricted ancestors', async () => {
    const root = await fixture()
    await mkdir(path.join(root, '.git'))
    await writeFile(path.join(root, '.git', 'config'), 'private')
    await mkdir(path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'node_modules', 'module.js'), 'export {}')
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n')

    const restrictedDirectory = await listWorkspaceDirectory(root, '.git')
    await expect(searchWorkspaceFiles(root, 'CONFIG')).resolves.toEqual({
      entries: restrictedDirectory.entries,
      truncated: false,
    })
    const rootEntries = (await listWorkspaceDirectory(root)).entries
    await expect(searchWorkspaceFiles(root, '.env')).resolves.toEqual({
      entries: rootEntries.filter((entry) => entry.name === '.env'),
      truncated: false,
    })
    await expect(searchWorkspaceFiles(root, 'module.js')).resolves.toMatchObject({
      entries: [{ path: 'node_modules/module.js', restricted: false }],
      truncated: false,
    })
  })

  it('ignores linked files, outside directories and directory cycles', async () => {
    const root = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'harness-workspace-search-outside-'))
    temporary.push(outside)
    await writeFile(path.join(outside, 'target.txt'), 'outside')
    await symlink(outside, path.join(root, 'target-directory'))
    await symlink(path.join(outside, 'target.txt'), path.join(root, 'target.txt'))
    await symlink(root, path.join(root, 'src', 'target-cycle'))
    await expect(searchWorkspaceFiles(root, 'target')).resolves.toEqual({
      entries: [],
      truncated: false,
    })
  })

  it('marks both explicit and default result limits as truncated', async () => {
    const root = await fixture()
    await Promise.all(
      Array.from({ length: 201 }, (_, index) =>
        writeFile(path.join(root, `match-${index}.txt`), ''),
      ),
    )
    const limited = await searchWorkspaceFiles(root, 'match', 2)
    expect(limited.entries).toHaveLength(2)
    expect(limited.truncated).toBe(true)
    const defaultLimit = await searchWorkspaceFiles(root, 'match')
    expect(defaultLimit.entries).toHaveLength(200)
    expect(defaultLimit.truncated).toBe(true)
  })

  it('bounds directory depth and reports unvisited descendants', async () => {
    const root = await fixture()
    const deepest = path.join(root, ...Array.from({ length: 34 }, () => 'd'))
    await mkdir(deepest, { recursive: true })
    await writeFile(path.join(deepest, 'target.txt'), 'not reached')

    await expect(searchWorkspaceFiles(root, 'target')).resolves.toEqual({
      entries: [],
      truncated: true,
    })
  })

  it('bounds visited entries even when none match without materializing the directory', async () => {
    const root = await fixture()
    let visited = 0
    const entries = {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 20_001; index += 1) {
          visited += 1
          yield {
            name: `file-${index}.txt`,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          }
        }
      },
    }
    vi.mocked(opendir).mockResolvedValueOnce(entries as Awaited<ReturnType<typeof opendir>>)

    await expect(searchWorkspaceFiles(root, 'not-present')).resolves.toEqual({
      entries: [],
      truncated: true,
    })
    expect(visited).toBeLessThanOrEqual(20_000)
  })
})
