import { parsePatchFiles } from '@pierre/diffs'
import type { DiffFile } from '@harness/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  workspaceDiffCollection,
  workspaceDiffFilePatch,
  workspaceDiffFilterCache,
  workspaceDiffItemId,
} from './workspace-diffs.js'

vi.mock('@pierre/diffs', { spy: true })

const modifiedFile = {
  path: 'src/index.ts',
  status: 'modified',
  binary: false,
  hunks: [
    {
      id: 'hunk-1',
      header: '@@ -1,2 +1,2 @@',
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { kind: 'context', oldLine: 1, newLine: 1, text: 'const before = true' },
        { kind: 'deletion', oldLine: 2, text: 'old value', noNewlineAtEnd: true },
        { kind: 'addition', newLine: 2, text: 'new value', noNewlineAtEnd: true },
      ],
    },
  ],
} satisfies DiffFile

describe('workspace diffs', () => {
  it('filters without reparsing previously visible files', () => {
    const files: DiffFile[] = [
      modifiedFile,
      { ...modifiedFile, path: 'docs/index.md', previousPath: 'old.md', status: 'renamed' },
      { ...modifiedFile, path: 'assets/icon', binary: true },
    ]
    const matches = ['', 'i', 'index', 'docs', 'none', ''].map((query) =>
      files.filter((file) => file.path.includes(query)),
    )
    const parse = vi.mocked(parsePatchFiles)
    parse.mockClear()
    const expected = matches.map((selection) => workspaceDiffCollection('v', selection))
    expect(parse).toHaveBeenCalledTimes(9)
    parse.mockClear()
    const cached = workspaceDiffFilterCache('v')
    expect(matches.map(cached)).toEqual(expected)
    expect(parse).toHaveBeenCalledTimes(2)
  })

  it('keeps parse-error fallbacks when a file becomes visible again', () => {
    const parse = vi.mocked(parsePatchFiles)
    parse.mockClear()
    parse.mockReturnValueOnce([])
    const cached = workspaceDiffFilterCache('v')
    const expected = { items: [], fallbacks: [{ file: modifiedFile, reason: 'parse-error' }] }
    expect(cached([modifiedFile])).toEqual(expected)
    expect(cached([])).toEqual({ items: [], fallbacks: [] })
    expect(cached([modifiedFile])).toEqual(expected)
    expect(parse).toHaveBeenCalledTimes(1)
  })

  it('reconstructs a unified patch from the workspace diff contract', () => {
    expect(workspaceDiffFilePatch(modifiedFile)).toBe(
      [
        'diff --git a/src/index.ts b/src/index.ts',
        '--- a/src/index.ts',
        '+++ b/src/index.ts',
        '@@ -1,2 +1,2 @@',
        ' const before = true',
        '-old value',
        '\\ No newline at end of file',
        '+new value',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
  })

  it('uses dev-null and previous paths for file status changes', () => {
    expect(
      workspaceDiffFilePatch({ ...modifiedFile, status: 'added', path: 'src/new.ts' }).startsWith(
        'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n',
      ),
    ).toBe(true)
    expect(
      workspaceDiffFilePatch({
        ...modifiedFile,
        status: 'renamed',
        previousPath: 'src/old.ts',
        path: 'src/new.ts',
      }).startsWith('diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n'),
    ).toBe(true)
  })

  it('creates virtualized Diffs.com items and leaves binary files to the fallback', () => {
    const binaryFile = {
      path: 'assets/image.png',
      status: 'modified',
      binary: true,
      hunks: [],
    } satisfies DiffFile
    const result = workspaceDiffCollection('tree-1', [modifiedFile, binaryFile])

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: workspaceDiffItemId(modifiedFile.path),
      type: 'diff',
    })
    expect(result.fallbacks).toEqual([{ file: binaryFile, reason: 'binary' }])
  })

  it('keeps hunkless changes and pure renames in the Diffs.com collection', () => {
    const emptyFile = {
      path: 'src/empty.ts',
      status: 'added',
      binary: false,
      hunks: [],
    } satisfies DiffFile
    const renamedFile = {
      path: 'src/new.ts',
      previousPath: 'src/old.ts',
      status: 'renamed',
      binary: false,
      hunks: [],
    } satisfies DiffFile
    const result = workspaceDiffCollection('tree-2', [emptyFile, renamedFile])

    expect(result.fallbacks).toEqual([])
    expect(result.items.map((item) => item.fileDiff.type)).toEqual(['new', 'rename-pure'])
    expect(result.items[1]?.fileDiff.prevName).toBe('src/old.ts')
  })

  it('names files whose paths contain spaces, tabs or newlines exactly', () => {
    const result = workspaceDiffCollection('tree-4', [
      { path: 'docs/a b/new file.md', status: 'added', binary: false, hunks: [] },
      { ...modifiedFile, path: 'src/tab\tname.ts' },
      { ...modifiedFile, path: 'src/line\nbreak.ts' },
      { ...modifiedFile, status: 'renamed', previousPath: 'old dir/a.ts', path: 'new dir/a.ts' },
    ])

    expect(result.fallbacks).toEqual([])
    expect(result.items.map(({ fileDiff }) => [fileDiff.name, fileDiff.prevName])).toEqual([
      ['docs/a b/new file.md', undefined],
      ['src/tab\tname.ts', undefined],
      ['src/line\nbreak.ts', undefined],
      ['new dir/a.ts', 'old dir/a.ts'],
    ])
    expect(workspaceDiffFilePatch({ ...modifiedFile, path: 'src/"q"\\\tx.ts' })).toContain(
      String.raw`diff --git "a/src/\"q\"\\\tx.ts" "b/src/\"q\"\\\tx.ts"`,
    )
  })

  it('marks added and deleted files with content as new and deleted', () => {
    const result = workspaceDiffCollection('tree-3', [
      { ...modifiedFile, status: 'added', path: 'src/new.ts' },
      { ...modifiedFile, status: 'deleted', path: 'src/old.ts' },
    ])

    expect(result.fallbacks).toEqual([])
    expect(result.items.map((item) => item.fileDiff.type)).toEqual(['new', 'deleted'])
  })
})
