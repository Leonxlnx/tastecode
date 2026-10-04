// @vitest-environment happy-dom
import type { DiffFile } from '@harness/contracts'
import { cleanup, render, type RenderResult } from '@testing-library/react'
import { afterAll, beforeAll, bench, describe } from 'vitest'
import { ReviewTree } from './WorkspaceReview.js'

const FILES = Array.from({ length: 200 }, (_, index): DiffFile => ({
  path: `src/generated/file-${String(index).padStart(3, '0')}.ts`,
  status: 'modified',
  binary: false,
  hunks: [],
}))
const selectFile = () => undefined
let view: RenderResult

beforeAll(() => {
  view = render(<ReviewTree files={FILES} onSelect={selectFile} />)
})

afterAll(() => cleanup())

describe('unchanged workspace review tree update', () => {
  bench(
    'rerenders an unchanged 200-file tree',
    () => {
      view.rerender(<ReviewTree files={FILES} onSelect={selectFile} />)
      if (view.container.querySelectorAll('.workspace-review__tree-file').length !== 200) {
        throw new Error('invalid review tree output')
      }
    },
    { time: 1_200, warmupTime: 300 },
  )
})
