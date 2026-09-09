// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DiffFile } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewTree } from './WorkspaceReview.js'

const virtualizerOptions = vi.hoisted(() => vi.fn())

vi.mock('@pierre/diffs/react', () => ({ CodeView: () => null }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; getItemKey: (index: number) => string }) => {
    virtualizerOptions(options)
    return {
      getTotalSize: () => options.count * 29,
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 8) }, (_, index) => ({
          index,
          key: options.getItemKey(index),
          start: index * 29,
        })),
    }
  },
}))

const files = (count: number): DiffFile[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `generated/output-${String(index).padStart(5, '0')}.ts`,
    status: 'modified',
    binary: false,
    hunks: [],
  }))

afterEach(() => {
  cleanup()
  virtualizerOptions.mockClear()
})

describe('workspace review tree virtualization', () => {
  it('keeps a normal review on the complete recursive path', () => {
    render(<ReviewTree files={files(50)} onSelect={() => {}} />)

    expect(virtualizerOptions).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button')).toHaveLength(51)
    expect(screen.getByTitle('generated/output-00049.ts')).toBeTruthy()
  })

  it('mounts only the large review window and retains folder interaction', () => {
    const onSelect = vi.fn()
    render(<ReviewTree files={files(1_000)} onSelect={onSelect} />)

    expect(virtualizerOptions.mock.lastCall?.[0]).toMatchObject({ count: 1_001 })
    expect(screen.getAllByRole('button')).toHaveLength(8)
    expect(screen.queryByTitle('generated/output-00999.ts')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'generated' }))
    expect(virtualizerOptions.mock.lastCall?.[0]).toMatchObject({ count: 1 })
    expect(screen.getByRole('button', { name: 'generated' }).getAttribute('aria-expanded')).toBe(
      'false',
    )

    fireEvent.click(screen.getByRole('button', { name: 'generated' }))
    fireEvent.click(screen.getByTitle('generated/output-00000.ts'))
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'generated/output-00000.ts' }),
    )
  })
})
