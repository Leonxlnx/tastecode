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

/** What the server reports. Projects live there now, not in localStorage. */
let serverProjects: unknown[] = []

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('harness.provider', 'codex')
  serverProjects = [
    {
      path: '/work/project',
      name: 'project',
      pinned: false,
      createdAt: 0,
      sessions: [
        {
          id: 'untouched-thread',
          title: 'New session',
          provider: 'codex',
          createdAt: 0,
          running: false,
        },
      ],
    },
  ]

  transport.request.mockImplementation((method: string, params: unknown) => {
    switch (method) {
      case 'models.list':
        return Promise.resolve({ models: [] })
      case 'workspace.info':
        return Promise.resolve({ added: 0, removed: 0, dirtyFiles: 0 })
      case 'auth.status':
        return Promise.resolve({ signedIn: true })
      case 'projects.list':
        return Promise.resolve({ projects: serverProjects })
      case 'thread.history':
        return Promise.resolve({ events: [], running: false })
      case 'thread.delete': {
        // The server really does drop it, so the next listing must agree.
        const { threadId } = params as { threadId: string }
        serverProjects = serverProjects.map((project) => {
          const p = project as { sessions: Array<{ id: string }> }
          return { ...p, sessions: p.sessions.filter((s) => s.id !== threadId) }
        })
        return Promise.resolve({})
      }
      case 'thread.start': {
        // The real server records the session as it starts it, so the next
        // listing has to show it or the rail would stay empty.
        const { workspacePath } = params as { workspacePath: string }
        serverProjects = serverProjects.map((project) => {
          const p = project as { path: string; sessions: unknown[] }
          if (p.path !== workspacePath) return p
          return {
            ...p,
            sessions: [
              ...p.sessions,
              {
                id: 'thread-1',
                title: 'New session',
                provider: 'codex',
                createdAt: 1,
                running: false,
              },
            ],
          }
        })
        return Promise.resolve({ threadId: 'thread-1' })
      }
      case 'thread.rename': {
        const { threadId, title } = params as { threadId: string; title: string }
        serverProjects = serverProjects.map((project) => {
          const p = project as { sessions: Array<{ id: string }> }
          return {
            ...p,
            sessions: p.sessions.map((s) => (s.id === threadId ? { ...s, title } : s)),
          }
        })
        return Promise.resolve({})
      }
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
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))

    const actions = document.querySelector<HTMLElement>('.rail__actions')
    expect(actions).not.toBeNull()
    fireEvent.click(within(actions!).getByRole('button', { name: 'New chat' }))

    expect(transport.request).not.toHaveBeenCalledWith('thread.start', expect.anything())
    // Deleted rather than closed: a session nobody typed into is bookkeeping,
    // not history, and closing would leave it in the rail forever.
    expect(transport.request).toHaveBeenCalledWith('thread.delete', {
      threadId: 'untouched-thread',
    })
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(0))

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

describe('reopening a session', () => {
  /**
   * Asserting on the request rather than on rendered rows: happy-dom gives
   * every element zero size and has no ResizeObserver, so the virtualiser
   * measures nothing and renders nothing. That replaying these events rebuilds
   * the conversation is covered in thread-store.test.ts, where it is the actual
   * logic rather than a rendering side effect.
   */
  it('asks the server what already happened rather than showing an empty pane', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('.sessrow')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))

    // The conversation used to exist only in the events this client had
    // personally seen, so switching or reloading showed nothing.
    await waitFor(() => {
      expect(transport.request).toHaveBeenCalledWith('thread.history', {
        threadId: 'untouched-thread',
      })
    })
  })
})
