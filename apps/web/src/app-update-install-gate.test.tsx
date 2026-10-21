// @vitest-environment happy-dom
import type { MethodName } from '@harness/contracts'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from './test-transport.js'
import type { Project, Session } from './ui/Sidebar.js'

const bridge = vi.hoisted(() => ({ install: vi.fn<() => Promise<boolean>>() }))
vi.mock('./bridge.js', () => ({ installAppUpdate: bridge.install }))

const {
  appUpdateInstallState,
  INSTALL_SETTLE_MS,
  requestAppUpdateInstall,
  resetAppUpdateInstallForTests,
  stopChatsAndInstall,
  useAppUpdateInstallGate,
} = await import('./app-update-install.js')

/**
 * The server side of Install now, as far as queued prompts go: they are
 * saved and survive the restart, Stop all deletes them in every chat, and a
 * turn that ends sends the chat's next queued prompt at once.
 */
type Chat = {
  running: boolean
  queue: string[]
  /** A running turn that waits on the user. */
  waits?: 'approval' | 'input'
}

function server(chats: Record<string, Chat>) {
  const log: string[] = []
  const sent: string[] = []
  let interruptBarrier: Promise<void> | undefined
  const transport = new TestTransport(async (method: MethodName, params: unknown) => {
    const threadId = (params as { threadId?: string }).threadId
    log.push(threadId ? `${method} ${threadId}` : method)
    switch (method) {
      case 'projects.list':
        return {
          projects: [
            {
              path: '/repo',
              name: 'repo',
              pinned: false,
              createdAt: 0,
              sessions: Object.entries(chats).map(([id, chat]) => ({
                id,
                title: id,
                provider: 'codex',
                createdAt: 0,
                running: chat.running,
                // The server's order: a wait on the user, then the turn, then the queue.
                status: chat.running
                  ? (chat.waits ?? 'working')
                  : chat.queue.length > 0
                    ? 'queued'
                    : 'idle',
              })),
            },
          ],
        }
      case 'thread.queue':
        return {
          items: chats[threadId!]!.queue.map((text, index) => ({
            id: `${threadId}-${index}`,
            text,
            attachments: [],
            createdAt: index,
          })),
          canSteer: false,
        }
      case 'thread.interrupt': {
        await interruptBarrier
        const chat = chats[threadId!]!
        chat.running = false
        const next = chat.queue.shift()
        if (next !== undefined) {
          sent.push(next)
          chat.running = true
        }
        return {}
      }
      case 'system.panicStop':
        for (const chat of Object.values(chats)) {
          chat.queue.length = 0
          chat.running = false
        }
        return { sessions: [] }
      default:
        throw new Error(`Unhandled test request: ${method}`)
    }
  })
  return {
    transport,
    log,
    sent,
    /** An agent that never answers Stop. */
    hangInterrupts: () => {
      interruptBarrier = new Promise<void>(() => {})
    },
  }
}

function sidebar(statuses: Record<string, Session['status']>): Project[] {
  return [
    {
      path: '/repo',
      sessions: Object.entries(statuses).map(([id, status]) => ({
        id,
        title: id,
        provider: 'codex',
        createdAt: 0,
        status,
        lifecycle: { state: 'active', keepActive: false },
        unread: false,
      })),
    },
  ]
}

beforeEach(() => {
  bridge.install.mockImplementation(async () => true)
})

afterEach(() => {
  cleanup()
  resetAppUpdateInstallForTests()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('Install now', () => {
  it('keeps every queued prompt and stops the turns it can stop without sending one', async () => {
    const chats = {
      // Runs, with two follow-ups typed while it ran.
      a: { running: true, queue: ['Follow-up 1', 'Follow-up 2'] },
      // Runs, nothing queued.
      b: { running: true, queue: [] },
      // Runs nothing, but kept a prompt from before the last restart.
      c: { running: false, queue: ['Written before the restart'] },
    }
    const fake = server(chats)
    bridge.install.mockImplementation(async () => {
      fake.log.push('install')
      return true
    })
    renderHook(() =>
      useAppUpdateInstallGate(
        fake.transport,
        sidebar({ a: 'working', b: 'working', c: 'queued' }),
        true,
      ),
    )

    await requestAppUpdateInstall()
    // c runs nothing, so only a and b hold the update.
    expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 2 })
    await stopChatsAndInstall()

    expect(chats.a.queue).toEqual(['Follow-up 1', 'Follow-up 2'])
    expect(chats.c.queue).toEqual(['Written before the restart'])
    // Ending a's turn would have sent its first follow-up, only for the restart to cut it off.
    expect(fake.sent).toEqual([])
    expect(fake.log).not.toContain('system.panicStop')
    expect(fake.log.filter((call) => call.startsWith('thread.interrupt'))).toEqual([
      'thread.interrupt b',
    ])
    expect(fake.log.at(-1)).toBe('install')
    expect(bridge.install).toHaveBeenCalledOnce()
  })

  it('still installs when a chat does not stop in time', async () => {
    vi.useFakeTimers()
    const fake = server({ a: { running: true, queue: [] } })
    fake.hangInterrupts()
    renderHook(() => useAppUpdateInstallGate(fake.transport, sidebar({ a: 'working' }), true))

    await requestAppUpdateInstall()
    const installing = stopChatsAndInstall()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(appUpdateInstallState()).toEqual({ phase: 'stopping', running: 1 })
    expect(bridge.install).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await installing
    expect(fake.log).toContain('thread.interrupt a')
    expect(bridge.install).toHaveBeenCalledOnce()
  })
})

describe('Waiting for chats', () => {
  it('installs at once when a chat only holds prompts queued before a restart', async () => {
    vi.useFakeTimers()
    const chats = { c: { running: false, queue: ['Written before the restart'] } }
    const fake = server(chats)
    renderHook(() => useAppUpdateInstallGate(fake.transport, sidebar({ c: 'queued' }), true))

    await requestAppUpdateInstall()

    expect(fake.log).toEqual(['projects.list'])
    expect(bridge.install).toHaveBeenCalledOnce()
    expect(appUpdateInstallState()).toEqual({ phase: 'installing' })
    expect(chats.c.queue).toEqual(['Written before the restart'])
  })

  it('waits for a running turn, an approval and a question', async () => {
    vi.useFakeTimers()
    const fake = server({
      a: { running: true, queue: [] },
      b: { running: true, queue: [], waits: 'approval' },
      c: { running: true, queue: [], waits: 'input' },
      d: { running: false, queue: ['Written before the restart'] },
    })
    renderHook(() =>
      useAppUpdateInstallGate(
        fake.transport,
        sidebar({ a: 'working', b: 'approval', c: 'input', d: 'queued' }),
        true,
      ),
    )

    await requestAppUpdateInstall()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 3 })
    expect(bridge.install).not.toHaveBeenCalled()
  })

  it('installs once the last turn ends, even when its next prompt stays queued', async () => {
    vi.useFakeTimers()
    const a: Chat = { running: true, queue: ['Follow-up'] }
    const b: Chat = { running: true, queue: [], waits: 'approval' }
    const fake = server({ a, b })
    const view = renderHook(
      ({ projects }) => useAppUpdateInstallGate(fake.transport, projects, true),
      { initialProps: { projects: sidebar({ a: 'working', b: 'approval' }) } },
    )
    await requestAppUpdateInstall()
    expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 2 })

    // The approval is answered and b's turn ends.
    b.running = false
    delete b.waits
    view.rerender({ projects: sidebar({ a: 'working', b: 'ready' }) })
    expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 1 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bridge.install).not.toHaveBeenCalled()

    // a's turn ends and the server cannot start its follow-up, so it stays queued.
    a.running = false
    view.rerender({ projects: sidebar({ a: 'ready', b: 'ready' }) })
    await vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS)

    expect(bridge.install).toHaveBeenCalledOnce()
    expect(appUpdateInstallState()).toEqual({ phase: 'installing' })
    expect(a.queue).toEqual(['Follow-up'])
  })
})
