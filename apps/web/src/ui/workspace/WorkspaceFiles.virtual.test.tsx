// @vitest-environment happy-dom
import { methods } from '@harness/contracts'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'

const virtualizerOptions = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; getItemKey?: (index: number) => string }) => {
    virtualizerOptions(options)
    return {
      getTotalSize: () => options.count * 29,
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 8) }, (_, index) => ({
          index,
          key: options.getItemKey?.(index) ?? index,
          start: index * 29,
        })),
    }
  },
}))

const { WorkspaceFiles } = await import('./WorkspaceFiles.js')

const file = (index: number) => ({
  name: `nested-${String(index).padStart(5, '0')}.ts`,
  path: `src/nested-${String(index).padStart(5, '0')}.ts`,
  kind: 'file' as const,
  size: 12,
  modifiedAt: 0,
  restricted: false,
})

afterEach(() => {
  cleanup()
  virtualizerOptions.mockClear()
})

describe('WorkspaceFiles tree virtualization', () => {
  it('keeps a normal file tree on the complete recursive path', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => file(index))
    const transport = new TestTransport((method) => {
      if (method === 'workspace.listDirectory') return { path: '', entries }
      throw new Error(`Unhandled test request: ${method}`)
    })

    render(<WorkspaceFiles transport={transport} projectPath="/project" />)

    expect(
      await within(screen.getByLabelText('Workspace file tree')).findAllByRole('button'),
    ).toHaveLength(50)
    expect(virtualizerOptions).not.toHaveBeenCalled()
    expect(screen.getByTitle('src/nested-00049.ts')).toBeTruthy()
  })

  it('virtualizes at the 200-row boundary', async () => {
    const entries = Array.from({ length: 200 }, (_, index) => file(index))
    const transport = new TestTransport((method) => {
      if (method === 'workspace.listDirectory') return { path: '', entries }
      throw new Error(`Unhandled test request: ${method}`)
    })

    render(<WorkspaceFiles transport={transport} projectPath="/project" />)

    await waitFor(() => {
      expect(virtualizerOptions.mock.lastCall?.[0]).toMatchObject({ count: 200 })
    })
    expect(
      within(screen.getByLabelText('Workspace file tree')).getAllByRole('button'),
    ).toHaveLength(8)
    expect(screen.queryByTitle('src/nested-00199.ts')).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter workspace files'), {
      target: { value: '00199' },
    })
    await waitFor(() => {
      expect(virtualizerOptions.mock.lastCall?.[0]).toMatchObject({ count: 1 })
    })
    expect(screen.getByTitle('src/nested-00199.ts')).toBeTruthy()
  })

  it('mounts only the large visible window and retains folder interaction', async () => {
    const nested = Array.from({ length: 1_000 }, (_, index) => file(index))
    const transport = new TestTransport((method, params) => {
      if (method === 'workspace.listDirectory') {
        const request = methods[method].params.parse(params)
        return request.directory === 'src'
          ? { path: 'src', entries: nested }
          : {
              path: '',
              entries: [
                {
                  name: 'src',
                  path: 'src',
                  kind: 'directory' as const,
                  size: 0,
                  modifiedAt: 0,
                  restricted: false,
                },
              ],
            }
      }
      if (method === 'workspace.readFile') {
        const request = methods[method].params.parse(params)
        return {
          name: request.path,
          path: request.path,
          size: 12,
          binary: false,
          truncated: false,
          content: 'nested',
        }
      }
      throw new Error(`Unhandled test request: ${method}`)
    })

    render(<WorkspaceFiles transport={transport} projectPath="/project" />)
    fireEvent.click(await screen.findByTitle('src'))

    await waitFor(() => {
      expect(virtualizerOptions.mock.lastCall?.[0]).toMatchObject({ count: 1_001 })
    })
    expect(
      within(screen.getByLabelText('Workspace file tree')).getAllByRole('button'),
    ).toHaveLength(8)
    expect(screen.queryByTitle('src/nested-00999.ts')).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter workspace files'), {
      target: { value: '00999' },
    })
    expect(await screen.findByTitle('src/nested-00999.ts')).toBeTruthy()
    expect(
      within(screen.getByLabelText('Workspace file tree')).getAllByRole('button'),
    ).toHaveLength(2)

    fireEvent.change(screen.getByLabelText('Filter workspace files'), { target: { value: '' } })
    await waitFor(() => expect(screen.queryByTitle('src/nested-00999.ts')).toBeNull())

    fireEvent.click(screen.getByTitle('src'))
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Workspace file tree')).getAllByRole('button'),
      ).toHaveLength(1),
    )
    expect(screen.getByTitle('src').getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByTitle('src'))
    const first = await screen.findByTitle('src/nested-00000.ts')
    fireEvent.click(first)
    expect(first.classList).toContain('is-selected')
    await waitFor(() => expect(screen.getByText('src/nested-00000.ts')).toBeTruthy())
  })
})
