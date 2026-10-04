import type { DiffFile } from '@harness/contracts'
import { bench, describe } from 'vitest'
import { buildReviewTree } from './review-file-tree.js'

type LegacyTreeNode = {
  name: string
  path: string
  children: LegacyTreeNode[]
  file?: DiffFile
}

const OPTIONS = { iterations: 10, time: 0, warmupIterations: 3, warmupTime: 0 }
const FILES = Array.from({ length: 10_000 }, (_, index): DiffFile => ({
  path: `generated/output-${String(index).padStart(5, '0')}.ts`,
  status: 'modified',
  binary: false,
  hunks: [],
}))
const SMALL_FILES = Array.from({ length: 50 }, (_, index): DiffFile => ({
  path: `src/feature-${index % 5}/file-${String(index).padStart(2, '0')}.ts`,
  status: 'modified',
  binary: false,
  hunks: [],
}))

function legacyBuildReviewTree(files: DiffFile[]): LegacyTreeNode[] {
  const root: LegacyTreeNode = { name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.replaceAll('\\', '/').split('/').filter(Boolean)
    let parent = root
    parts.forEach((part, index) => {
      const currentPath = parts.slice(0, index + 1).join('/')
      let node = parent.children.find((child) => child.name === part)
      if (!node) {
        node = { name: part, path: currentPath, children: [] }
        parent.children.push(node)
      }
      if (index === parts.length - 1) node.file = file
      parent = node
    })
  }
  const sort = (nodes: LegacyTreeNode[]): LegacyTreeNode[] =>
    nodes
      .sort((left, right) => {
        if (Boolean(left.file) !== Boolean(right.file)) return left.file ? 1 : -1
        return left.name.localeCompare(right.name, undefined, { numeric: true })
      })
      .map((node) => ({ ...node, children: sort(node.children) }))
  return sort(root.children)
}

describe('large workspace review file tree', () => {
  bench(
    'scans existing siblings while inserting 10,000 files',
    () => {
      const tree = legacyBuildReviewTree(FILES)
      if (tree[0]?.children.length !== FILES.length) throw new Error('invalid review tree')
    },
    OPTIONS,
  )

  bench(
    'indexes each folder while inserting 10,000 files',
    () => {
      const tree = buildReviewTree(FILES)
      if (tree[0]?.children.length !== FILES.length) throw new Error('invalid review tree')
    },
    OPTIONS,
  )
})

describe('normal workspace review file tree', () => {
  bench(
    'scans siblings while inserting 50 files',
    () => {
      const tree = legacyBuildReviewTree(SMALL_FILES)
      if (tree.length !== 1) throw new Error('invalid review tree')
    },
    OPTIONS,
  )

  bench(
    'indexes folders while inserting 50 files',
    () => {
      const tree = buildReviewTree(SMALL_FILES)
      if (tree.length !== 1) throw new Error('invalid review tree')
    },
    OPTIONS,
  )
})
