// @vitest-environment happy-dom
import { methods } from '@harness/contracts'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { WorkspaceFiles } from './WorkspaceFiles.js'

const file = (name: string, path = name) => ({
  name,
  path,
  kind: 'file' as const,
  size: 12,
  modifiedAt: 0,
  restricted: false,
})

afterEach(() => cleanup())

describe('WorkspaceFiles', () => {
  it('refreshes a reopened folder and ignores an older overlapping result', async () => {
    const pending: Array<(value: unknown) => void> = []
    const folder = { ...file('src'), kind: 'directory' as const }
    const transport = new TestTransport((method, params) => {
      if (method !== 'workspace.listDirectory') throw new Error('Unexpected request')
      const request = methods[method].params.parse(params)
      if (!request.directory) return { path: '', entries: [folder] }
      return new Promise((resolve) => pending.push(resolve))
    })
    render(<WorkspaceFiles transport={transport} projectPath="/project" />)
    const button = await screen.findByTitle('src')
    fireEvent.click(button)
    await act(async () => pending[0]!({ path: 'src', entries: [file('old.ts', 'src/old.ts')] }))
    expect(screen.getByTitle('src/old.ts')).toBeTruthy()
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))
    await act(async () => pending[2]!({ path: 'src', entries: [file('new.ts', 'src/new.ts')] }))
    await act(async () => pending[1]!({ path: 'src', entries: [file('stale.ts', 'src/stale.ts')] }))
    expect(screen.getByTitle('src/new.ts')).toBeTruthy()
    expect(screen.queryByTitle('src/old.ts')).toBeNull()
    expect(screen.queryByTitle('src/stale.ts')).toBeNull()
  })

  it('coalesces completion and reconnect refreshes without reading on token deltas', async () => {
    const transport = new TestTransport(() => ({ path: '', entries: [] }))
    render(<WorkspaceFiles transport={transport} projectPath="/project" threadId="thread" />)
    await waitFor(() => expect(transport.requests).toHaveLength(1))
    act(() => {
      for (let index = 0; index < 20; index += 1)
        transport.emit('thread.event', {
          threadId: 'thread',
          event: { type: 'item.delta', turnId: 'turn', itemId: 'item', textDelta: 'text' },
        })
    })
    expect(transport.requests).toHaveLength(1)
    act(() => {
      transport.emit('thread.event', {
        threadId: 'thread',
        event: { type: 'turn.completed', turnId: 'turn', status: 'completed' },
      })
      transport.emitState('open')
    })
    await waitFor(() => expect(transport.requests).toHaveLength(2))
  })
  it('moves selection between file rows and clears it when the project changes', async () => {
    const entries = [file('one.ts'), file('two.ts')]
    const transport = new TestTransport((method, params) => {
      if (method === 'workspace.listDirectory') {
        const request = methods[method].params.parse(params)
        return { path: request.directory ?? '', entries }
      }
      if (method === 'workspace.readFile') {
        const request = methods[method].params.parse(params)
        return {
          name: request.path,
          path: request.path,
          size: 12,
          binary: false,
          truncated: false,
          content: 'const value = 1',
        }
      }
      throw new Error(`Unhandled test request: ${method}`)
    })
    const view = render(
      <WorkspaceFiles transport={transport} projectPath="/first" projectName="First" />,
    )

    const first = await screen.findByTitle('one.ts')
    const second = await screen.findByTitle('two.ts')
    fireEvent.click(first)
    expect(first.classList).toContain('is-selected')
    expect(second.classList).not.toContain('is-selected')

    fireEvent.click(second)
    expect(first.classList).not.toContain('is-selected')
    expect(second.classList).toContain('is-selected')
    await waitFor(() => expect(screen.getByText('two.ts')).toBeTruthy())

    view.rerender(
      <WorkspaceFiles transport={transport} projectPath="/second" projectName="Second" />,
    )
    await waitFor(() => {
      expect(view.container.querySelector('.workspace-files__entry.is-selected')).toBeNull()
    })
  })

  it('still expands folders and selects nested files', async () => {
    const transport = new TestTransport((method, params) => {
      if (method === 'workspace.listDirectory') {
        const request = methods[method].params.parse(params)
        return request.directory === 'src'
          ? { path: 'src', entries: [file('nested.ts', 'src/nested.ts')] }
          : {
              path: '',
              entries: [
                {
                  name: 'src',
                  path: 'src',
                  kind: 'directory',
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
          name: 'nested.ts',
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
    const nested = await screen.findByTitle('src/nested.ts')
    fireEvent.click(nested)
    expect(nested.classList).toContain('is-selected')
    await waitFor(() => expect(screen.getByText('src/nested.ts')).toBeTruthy())
  })
})
