// @vitest-environment happy-dom
import { render, waitFor } from '@testing-library/react'
import { bench, describe, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 40) }, (_, index) => ({
        key: index,
        index,
        start: index * 29,
      })),
  }),
}))

const { WorkspaceFiles } = await import('./WorkspaceFiles.js')

const entries = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `file-${String(index).padStart(5, '0')}.ts`,
    path: `src/generated/file-${String(index).padStart(5, '0')}.ts`,
    kind: 'file' as const,
    size: 1_024,
    modifiedAt: 0,
    restricted: false,
  }))

const SHORT_ENTRIES = entries(50)
const THRESHOLD_ENTRIES = entries(200)
const LARGE_ENTRIES = entries(10_000)

const transportFor = (fileEntries: typeof LARGE_ENTRIES) =>
  new TestTransport((method) => {
    if (method === 'workspace.listDirectory') return { path: '', entries: fileEntries }
    throw new Error(`Unhandled benchmark request: ${method}`)
  })

const shortTransport = transportFor(SHORT_ENTRIES)
const thresholdTransport = transportFor(THRESHOLD_ENTRIES)
const largeTransport = transportFor(LARGE_ENTRIES)

async function renderWorkspaceFileTree(transport: TestTransport): Promise<void> {
  const view = render(
    <WorkspaceFiles transport={transport} projectPath="/project" projectName="Project" />,
  )
  try {
    await waitFor(() => {
      if (!view.container.querySelector('[title="src/generated/file-00000.ts"]')) {
        throw new Error('workspace file tree did not load')
      }
    })
  } finally {
    view.unmount()
  }
}

describe('workspace file tree load', () => {
  bench('renders the first view of 50 files', () => renderWorkspaceFileTree(shortTransport), {
    time: 1_200,
    warmupTime: 300,
  })

  bench('renders the first view of 200 files', () => renderWorkspaceFileTree(thresholdTransport), {
    time: 1_200,
    warmupTime: 300,
  })

  bench('renders the first view of 10,000 files', () => renderWorkspaceFileTree(largeTransport), {
    iterations: 8,
    time: 0,
    warmupIterations: 2,
    warmupTime: 0,
  })
})
