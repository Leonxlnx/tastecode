import type { DiffFile } from '@harness/contracts'

export type ReviewTreeNode = {
  name: string
  path: string
  children: ReviewTreeNode[]
  file?: DiffFile
}

export type ReviewTreeRow = {
  node: ReviewTreeNode
  depth: number
}

type MutableTreeNode = {
  name: string
  path: string
  children: MutableTreeNode[]
  // A deleted file and the folder that replaced it share a name, so each kind has its own index.
  foldersByName?: Map<string, MutableTreeNode>
  filesByName?: Map<string, MutableTreeNode>
  file?: DiffFile
}

const TREE_NODE_COLLATOR = new Intl.Collator(undefined, { numeric: true })

/** Build one immutable review tree without repeatedly scanning large sibling lists. */
export function buildReviewTree(files: readonly DiffFile[]): ReviewTreeNode[] {
  const root: MutableTreeNode = { name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.replaceAll('\\', '/').split('/').filter(Boolean)
    let parent = root
    let currentPath = ''
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const isFile = index === parts.length - 1
      const childrenByName = isFile
        ? (parent.filesByName ??= new Map())
        : (parent.foldersByName ??= new Map())
      let node = childrenByName.get(part)
      if (!node) {
        node = { name: part, path: currentPath, children: [] }
        childrenByName.set(part, node)
        parent.children.push(node)
      }
      if (isFile) node.file = file
      parent = node
    }
  }
  return finalizeTree(root.children)
}

/** A file and a folder can share a path, so rendered rows key on both. */
export function reviewTreeNodeKey(node: ReviewTreeNode): string {
  return `${node.file ? 'file' : 'folder'}:${node.path}`
}

/** Project only the currently open rows; virtual rendering consumes this flat order. */
export function flattenReviewTree(
  nodes: readonly ReviewTreeNode[],
  closedPaths: ReadonlySet<string>,
): ReviewTreeRow[] {
  const rows: ReviewTreeRow[] = []
  const pending: ReviewTreeRow[] = []
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    pending.push({ node: nodes[index]!, depth: 0 })
  }
  while (pending.length > 0) {
    const row = pending.pop()!
    rows.push(row)
    if (row.node.file || closedPaths.has(row.node.path)) continue
    for (let index = row.node.children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: row.node.children[index]!, depth: row.depth + 1 })
    }
  }
  return rows
}

function finalizeTree(nodes: MutableTreeNode[]): ReviewTreeNode[] {
  nodes.sort((left, right) => {
    if ((left.file !== undefined) !== (right.file !== undefined)) return left.file ? 1 : -1
    return TREE_NODE_COLLATOR.compare(left.name, right.name)
  })
  return nodes.map((node) => ({
    name: node.name,
    path: node.path,
    children: finalizeTree(node.children),
    ...(node.file ? { file: node.file } : {}),
  }))
}
