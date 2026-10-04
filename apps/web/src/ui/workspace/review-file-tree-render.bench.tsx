import type { DiffFile } from '@harness/contracts'
import { IconChevronDown as ChevronDown, IconFolder as Folder } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { bench, describe } from 'vitest'
import { FileTypeIcon } from '../FileTypeIcon.js'
import { ReviewTree } from './WorkspaceReview.js'
import {
  buildReviewTree,
  flattenReviewTree,
  type ReviewTreeNode,
  type ReviewTreeRow,
} from './review-file-tree.js'

const LARGE_FILES = Array.from({ length: 10_000 }, (_, index): DiffFile => ({
  path: `generated/output-${String(index).padStart(5, '0')}.ts`,
  status: 'modified',
  binary: false,
  hunks: [],
}))
const SMALL_FILES = LARGE_FILES.slice(0, 50)
const LARGE_TREE = buildReviewTree(LARGE_FILES)
const LARGE_OPTIONS = { iterations: 15, time: 0, warmupIterations: 5, warmupTime: 0 }
const SMALL_OPTIONS = { iterations: 50, time: 0, warmupIterations: 10, warmupTime: 0 }

function LegacyReviewTree({ tree }: { tree: ReviewTreeNode[] }) {
  return (
    <div className="workspace-review__tree-list">
      {tree.map((node) => (
        <LegacyReviewTreeNode key={node.path} node={node} depth={0} />
      ))}
    </div>
  )
}

function LegacyReviewTreeFromFiles({ files }: { files: DiffFile[] }) {
  const tree = useMemo(() => buildReviewTree(files), [files])
  return <LegacyReviewTree tree={tree} />
}

function LegacyReviewTreeNode({ node, depth }: { node: ReviewTreeNode; depth: number }) {
  const [open] = useState(true)
  if (node.file) {
    return (
      <button
        type="button"
        className="workspace-review__tree-file"
        style={{ paddingLeft: 10 + depth * 18 }}
        title={node.path}
      >
        <FileTypeIcon path={node.path} />
        <span>{node.name}</span>
        <i data-status={node.file.status}>M</i>
      </button>
    )
  }
  return (
    <div className="workspace-review__tree-folder">
      <button type="button" style={{ paddingLeft: 8 + depth * 18 }} aria-expanded={open}>
        <ChevronDown size={14} aria-hidden />
        <Folder size={14} aria-hidden />
        <span>{node.name}</span>
      </button>
      {open
        ? node.children.map((child) => (
            <LegacyReviewTreeNode key={child.path} node={child} depth={depth + 1} />
          ))
        : null}
    </div>
  )
}

function VirtualReviewTreeWindow({ tree }: { tree: ReviewTreeNode[] }) {
  const rows = flattenReviewTree(tree, new Set()).slice(0, 32)
  return (
    <div className="workspace-review__tree-list is-virtual">
      <div className="workspace-review__tree-canvas">
        {rows.map((row, index) => (
          <BenchmarkReviewTreeRow key={row.node.path} row={row} start={index * 29} />
        ))}
      </div>
    </div>
  )
}

function BenchmarkReviewTreeRow({ row, start }: { row: ReviewTreeRow; start: number }) {
  const { node, depth } = row
  if (node.file) {
    return (
      <button
        type="button"
        className="workspace-review__tree-file workspace-review__tree-row"
        style={{ paddingLeft: 10 + depth * 18, transform: `translateY(${start}px)` }}
        title={node.path}
      >
        <FileTypeIcon path={node.path} />
        <span>{node.name}</span>
        <i data-status={node.file.status}>M</i>
      </button>
    )
  }
  return (
    <div
      className="workspace-review__tree-folder workspace-review__tree-row"
      style={{ transform: `translateY(${start}px)` }}
    >
      <button type="button" style={{ paddingLeft: 8 + depth * 18 }} aria-expanded>
        <ChevronDown size={14} aria-hidden />
        <Folder size={14} aria-hidden />
        <span>{node.name}</span>
      </button>
    </div>
  )
}

describe('workspace review tree React render', () => {
  bench(
    'renders all 10,000 changed-file rows recursively',
    () => {
      const html = renderToStaticMarkup(<LegacyReviewTree tree={LARGE_TREE} />)
      if (!html.includes('output-09999.ts')) throw new Error('missing final review row')
    },
    LARGE_OPTIONS,
  )

  bench(
    'projects 10,000 rows and renders one visible window',
    () => {
      const html = renderToStaticMarkup(<VirtualReviewTreeWindow tree={LARGE_TREE} />)
      if (!html.includes('output-00030.ts')) throw new Error('missing visible review row')
    },
    LARGE_OPTIONS,
  )

  bench(
    'renders all 50 changed-file rows recursively',
    () => {
      const html = renderToStaticMarkup(<LegacyReviewTreeFromFiles files={SMALL_FILES} />)
      if (!html.includes('output-00049.ts')) throw new Error('missing final review row')
    },
    SMALL_OPTIONS,
  )

  bench(
    'keeps the complete 50-file review path',
    () => {
      const html = renderToStaticMarkup(<ReviewTree files={SMALL_FILES} onSelect={() => {}} />)
      if (!html.includes('output-00049.ts')) throw new Error('missing final review row')
    },
    SMALL_OPTIONS,
  )
})
