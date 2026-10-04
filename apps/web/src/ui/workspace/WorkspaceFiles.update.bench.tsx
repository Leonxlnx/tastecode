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

import { WorkspaceFiles } from './WorkspaceFiles.js'

const ENTRIES = Array.from({ length: 200 }, (_, index) => ({
  name: `file-${String(index).padStart(3, '0')}.ts`,
  path: `src/generated/file-${String(index).padStart(3, '0')}.ts`,
  kind: 'file' as const,
  size: 1_024,
  modifiedAt: 0,
  restricted: false,
}))

const transport = new TestTransport((method) => {
  if (method === 'workspace.listDirectory') return { path: '', entries: ENTRIES }
  if (method === 'workspace.readFile') return new Promise(() => {})
  throw new Error(`Unhandled benchmark request: ${method}`)
})

let view: RenderResult
let targets: HTMLElement[]
let nextTarget = 0

beforeAll(async () => {
  view = render(
    <WorkspaceFiles transport={transport} projectPath="/project" projectName="Project" />,
  )
  targets = await Promise.all(ENTRIES.slice(0, 2).map((entry) => view.findByTitle(entry.path)))
})

afterAll(() => view.unmount())

describe('workspace file selection update', () => {
  bench(
    'selects one file among 200 loaded files',
    () => {
      fireEvent.click(targets[nextTarget++ % targets.length]!)
      if (view.container.querySelectorAll('.workspace-files__entry.is-selected').length !== 1) {
        throw new Error('invalid workspace file selection')
      }
    },
    { time: 1_200, warmupTime: 300 },
  )
})
