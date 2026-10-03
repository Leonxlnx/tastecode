// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspaceFiles } from './WorkspaceFiles.js'

const entry = (path: string) => ({
  name: path.split('/').at(-1)!,
  path,
  kind: 'file' as const,
  size: 12,
  modifiedAt: 0,
  restricted: false,
})
const contents = (path: string, content: string) => ({
  name: path,
  path,
  content,
  size: content.length,
  binary: false,
  truncated: false,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('workspace file refresh', () => {
  it('rereads the selected file and removes deleted contents on failure', async () => {
    let read = 0
    const transport = new TestTransport((method) => {
      if (method === 'workspace.listDirectory') return { path: '', entries: [entry('file.ts')] }
      if (method === 'workspace.readFile') {
        read += 1
        if (read === 3) throw new Error('File no longer exists')
        return contents('file.ts', read === 1 ? 'old' : 'updated')
      }
      throw new Error(`Unexpected ${method}`)
    })
    render(<WorkspaceFiles transport={transport} projectPath="/project" />)
    fireEvent.click(await screen.findByTitle('file.ts'))
    expect(await screen.findByText('3 B')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))
    expect(await screen.findByText('7 B')).toBeTruthy()
    expect(screen.queryByText('3 B')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', ' File no longer exists')
    expect(screen.queryByText('7 B')).toBeNull()
  })

  it('ignores an open-file refresh that finishes after selecting another file', async () => {
    const stale = deferred<ReturnType<typeof contents>>()
    let reads = 0
    const transport = new TestTransport((method) => {
      if (method === 'workspace.listDirectory')
        return { path: '', entries: [entry('first.ts'), entry('second.ts')] }
      if (method === 'workspace.readFile') {
        reads += 1
        return reads === 2 ? stale.promise : contents(reads === 1 ? 'first.ts' : 'second.ts', 'new')
      }
      throw new Error(`Unexpected ${method}`)
    })
    render(<WorkspaceFiles transport={transport} projectPath="/project" />)
    fireEvent.click(await screen.findByTitle('first.ts'))
    await screen.findByText('3 B')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))
    fireEvent.click(screen.getByTitle('second.ts'))
    await screen.findByText('3 B')
    await act(async () => stale.resolve(contents('first.ts', 'stale contents')))
    expect(screen.queryByText('14 B')).toBeNull()
    expect(screen.getByText('3 B')).toBeTruthy()
  })
})

describe('workspace file search', () => {
  it('opens a matching directory and its unopened ancestors in the tree', async () => {
    vi.useFakeTimers()
    const folder = (path: string) => ({ ...entry(path), kind: 'directory' as const })
    const transport = new TestTransport((method, params) => {
      if (method === 'workspace.searchFiles')
        return { entries: [folder('src/deep')], truncated: false }
      if (method === 'workspace.listDirectory') {
        const directory = (params as { directory?: string }).directory ?? ''
        return {
          path: directory,
          entries:
            directory === 'src/deep'
              ? [entry('src/deep/file.ts')]
              : [folder(directory === 'src' ? 'src/deep' : 'src')],
        }
      }
      throw new Error(`Unexpected ${method}`)
    })
    render(<WorkspaceFiles transport={transport} projectPath="/project" />)
    const input = screen.getByLabelText('Filter workspace files')
    fireEvent.change(input, { target: { value: 'deep' } })
    await act(() => vi.advanceTimersByTimeAsync(200))
    await act(async () => fireEvent.click(screen.getByTitle('src/deep')))
    expect(input).toHaveProperty('value', '')
    expect(screen.getByTitle('src/deep/file.ts')).toBeTruthy()
    expect(screen.getByTitle('src').getAttribute('aria-expanded')).toBe('true')
  })

  it('debounces a project-wide search and opens results from unopened folders', async () => {
    vi.useFakeTimers()
    const transport = new TestTransport((method, params) => {
      if (method === 'workspace.listDirectory') return { path: '', entries: [] }
      if (method === 'workspace.searchFiles')
        return { entries: [entry('src/deep/needle.ts')], truncated: true }
      if (method === 'workspace.readFile')
        return contents((params as { path: string }).path, 'searched')
      throw new Error(`Unexpected ${method}`)
    })
    render(<WorkspaceFiles transport={transport} projectPath="/project" threadId="isolated" />)
    const input = screen.getByLabelText('Filter workspace files')
    fireEvent.change(input, { target: { value: 'need' } })
    await act(() => vi.advanceTimersByTimeAsync(100))
    expect(
      transport.requests.filter((request) => request.method === 'workspace.searchFiles'),
    ).toHaveLength(0)
    fireEvent.change(input, { target: { value: ' needle ' } })
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(
      transport.requests.filter((request) => request.method === 'workspace.searchFiles'),
    ).toEqual([
      {
        method: 'workspace.searchFiles',
        params: { projectPath: '/project', threadId: 'isolated', query: 'needle', limit: 500 },
      },
    ])
    expect(screen.getByText(/More files match/)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByTitle('src/deep/needle.ts')))
    expect(screen.getByText('8 B')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(
      transport.requests.filter((request) => request.method === 'workspace.searchFiles'),
    ).toHaveLength(2)
  })

  it('ignores stale query and project replies and restores the tree on clear', async () => {
    vi.useFakeTimers()
    const pending: Array<
      ReturnType<typeof deferred<{ entries: ReturnType<typeof entry>[]; truncated: boolean }>>
    > = []
    const transport = new TestTransport((method) => {
      if (method === 'workspace.listDirectory') return { path: '', entries: [entry('root.ts')] }
      if (method === 'workspace.searchFiles') {
        const request = deferred<{ entries: ReturnType<typeof entry>[]; truncated: boolean }>()
        pending.push(request)
        return request.promise
      }
      throw new Error(`Unexpected ${method}`)
    })
    const view = render(<WorkspaceFiles transport={transport} projectPath="/first" />)
    const input = screen.getByLabelText('Filter workspace files')
    fireEvent.change(input, { target: { value: 'first' } })
    await act(() => vi.advanceTimersByTimeAsync(200))
    fireEvent.change(input, { target: { value: 'second' } })
    await act(() => vi.advanceTimersByTimeAsync(200))
    await act(async () =>
      pending[1]!.resolve({ entries: [entry('deep/second.ts')], truncated: false }),
    )
    await act(async () =>
      pending[0]!.resolve({ entries: [entry('deep/first.ts')], truncated: false }),
    )
    expect(screen.getByTitle('deep/second.ts')).toBeTruthy()
    expect(screen.queryByTitle('deep/first.ts')).toBeNull()

    fireEvent.change(input, { target: { value: 'pending' } })
    await act(() => vi.advanceTimersByTimeAsync(200))
    view.rerender(<WorkspaceFiles transport={transport} projectPath="/second" />)
    await act(async () =>
      pending[2]!.resolve({ entries: [entry('old-project.ts')], truncated: false }),
    )
    expect(screen.queryByTitle('old-project.ts')).toBeNull()
    fireEvent.change(input, { target: { value: '' } })
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(screen.getByTitle('root.ts')).toBeTruthy()
    expect(screen.queryByTitle('deep/second.ts')).toBeNull()
  })

  it('falls back to the loaded tree when a server does not support file search', async () => {
    vi.useFakeTimers()
    const transport = new TestTransport((method) => {
      if (method === 'workspace.listDirectory')
        return { path: '', entries: [entry('local.ts'), entry('other.md')] }
      throw new Error('Unknown method workspace.searchFiles')
    })
    render(<WorkspaceFiles transport={transport} projectPath="/project" />)
    fireEvent.change(screen.getByLabelText('Filter workspace files'), {
      target: { value: 'local' },
    })
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(screen.getByTitle('local.ts')).toBeTruthy()
    expect(screen.queryByTitle('other.md')).toBeNull()
    expect(screen.getByText(/Showing matches in loaded folders only/)).toBeTruthy()
  })
})
