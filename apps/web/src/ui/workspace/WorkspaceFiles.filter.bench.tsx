// @vitest-environment happy-dom
import { fireEvent, render, type RenderResult } from '@testing-library/react'
import { afterAll, beforeAll, bench, describe, vi } from 'vitest'
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

const ENTRIES = Array.from({ length: 10_000 }, (_, index) => ({
  name: `file-${String(index).padStart(5, '0')}.ts`,
  path: `src/generated/file-${String(index).padStart(5, '0')}.ts`,
  kind: 'file' as const,
  size: 1_024,
  modifiedAt: 0,
  restricted: false,
}))

const transport = new TestTransport((method) => {
  if (method === 'workspace.listDirectory') return { path: '', entries: ENTRIES }
  throw new Error(`Unhandled benchmark request: ${method}`)
})

let view: RenderResult
let filter: HTMLInputElement
let showMatch = true

beforeAll(async () => {
  view = render(
    <WorkspaceFiles transport={transport} projectPath="/project" projectName="Project" />,
  )
  filter = (await view.findByLabelText('Filter workspace files')) as HTMLInputElement
  await view.findByTitle('src/generated/file-00000.ts')
})

afterAll(() => view.unmount())

describe('workspace file tree filter', () => {
  bench(
    'toggles one match across 10,000 loaded files',
    () => {
      fireEvent.change(filter, { target: { value: showMatch ? '09999' : '' } })
      const expected = showMatch ? 'src/generated/file-09999.ts' : 'src/generated/file-00000.ts'
      if (!view.container.querySelector(`[title="${expected}"]`)) {
        throw new Error('workspace file filter did not update')
      }
      showMatch = !showMatch
    },
    { time: 1_200, warmupTime: 300 },
  )
})
