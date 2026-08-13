import type { DiffFile } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  workspaceDiffCollection,
  workspaceDiffFilePatch,
  workspaceDiffItemId,
} from './workspace-diffs.js'

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
        'diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n',
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
})
