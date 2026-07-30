// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App.js'

const transport = vi.hoisted(() => ({
  request: vi.fn(),
}))

vi.mock('./transport.js', () => ({
  Transport: class {
    connect() {}
    close() {}
    on() {
      return () => {}
    }
    request(method: string, params: unknown) {
      return transport.request(method, params)
    }
  },
}))

vi.mock('./ui/highlighter.js', () => ({
  warmHighlighter: () => {},
}))

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('harness.provider', 'codex')
  localStorage.setItem(
    'harness.projects',
    JSON.stringify([
      {
        path: '/work/project',
        sessions: [{ id: 'untouched-thread', title: 'New session', status: 'idle' }],
      },
    ]),
  )
  transport.request.mockImplementation((method: string) => {
    switch (method) {
      case 'models.list':
        return Promise.resolve({ models: [] })
      case 'workspace.info':
        return Promise.resolve({ added: 0, removed: 0, dirtyFiles: 0 })
      case 'auth.status':
        return Promise.resolve({ signedIn: true })
      case 'thread.start':
        return Promise.resolve({ threadId: 'thread-1' })
      case 'thread.sendTurn':
        return Promise.resolve({ turnId: 'turn-1' })
      default:
        return Promise.resolve({})
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('new chats', () => {
  it('keeps an untouched session out of the sidebar until the first prompt', async () => {
    render(<App />)

    const actions = document.querySelector<HTMLElement>('.rail__actions')
    expect(actions).not.toBeNull()
    fireEvent.click(within(actions!).getByRole('button', { name: 'New chat' }))

    expect(transport.request).not.toHaveBeenCalledWith('thread.start', expect.anything())
    expect(transport.request).toHaveBeenCalledWith('thread.close', {
      threadId: 'untouched-thread',
    })
    expect(document.querySelectorAll('.sessrow')).toHaveLength(0)

    const composer = document.querySelector('textarea')
    expect(composer).not.toBeNull()
    fireEvent.change(composer!, { target: { value: 'Fix the sidebar' } })
    fireEvent.keyDown(composer!, { key: 'Enter' })

    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.start', {
        provider: 'codex',
        workspacePath: '/work/project',
        approval: 'ask',
      })
      expect(screen.getByRole('button', { name: 'Fix the sidebar' })).toBeTruthy()
    })
  })
})
