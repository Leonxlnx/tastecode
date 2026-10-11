import type { DiffFile } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { buildReviewTree, flattenReviewTree } from './review-file-tree.js'

const file = (path: string): DiffFile => ({
  path,
  status: 'modified',
  binary: false,
  hunks: [],
})

describe('workspace review file tree', () => {
  it('normalizes paths and orders folders before naturally sorted files', () => {
    const readme = file('README.md')
    const second = file('src/file2.ts')
    const tenth = file('src/file10.ts')
    const nestedA = file('src/nested/a.ts')
    const nestedB = file('src\\nested\\b.ts')

    const tree = buildReviewTree([tenth, readme, nestedB, second, nestedA])

    expect(tree.map((node) => node.name)).toEqual(['src', 'README.md'])
    expect(tree[0]?.children.map((node) => node.name)).toEqual(['nested', 'file2.ts', 'file10.ts'])
    expect(tree[0]?.children[0]?.children.map((node) => node.path)).toEqual([
      'src/nested/a.ts',
      'src/nested/b.ts',
    ])
    expect(tree[0]?.children[1]?.file).toBe(second)
  })

  it('keeps the latest file value for a repeated normalized path', () => {
    const first = file('src/file.ts')
    const latest = { ...file('src\\file.ts'), status: 'added' as const }

    const tree = buildReviewTree([first, latest])

    expect(tree[0]?.children).toHaveLength(1)
    expect(tree[0]?.children[0]?.file).toBe(latest)
  })

  it('keeps a deleted file apart from a folder that replaced it', () => {
    const deleted = { ...file('foo'), status: 'deleted' as const }
    const added = { ...file('foo/bar.ts'), status: 'added' as const }

    for (const files of [
      [deleted, added],
      [added, deleted],
    ]) {
      const tree = buildReviewTree(files)

      expect(tree.map((node) => [node.path, node.file])).toEqual([
        ['foo', undefined],
        ['foo', deleted],
      ])
      expect(flattenReviewTree(tree, new Set()).map(({ node }) => node.file)).toEqual([
        undefined,
        added,
        deleted,
      ])
    }
  })

  it('flattens open folders in display order and omits closed descendants', () => {
    const tree = buildReviewTree([file('src/nested/a.ts'), file('src/file.ts'), file('README.md')])

    expect(flattenReviewTree(tree, new Set()).map(({ node, depth }) => [node.path, depth])).toEqual(
      [
        ['src', 0],
        ['src/nested', 1],
        ['src/nested/a.ts', 2],
        ['src/file.ts', 1],
        ['README.md', 0],
      ],
    )
    expect(
      flattenReviewTree(tree, new Set(['src'])).map(({ node, depth }) => [node.path, depth]),
    ).toEqual([
      ['src', 0],
      ['README.md', 0],
    ])
  })
})
