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
function server(chats: Record<string, { running: boolean; queue: string[] }>) {
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
                status: chat.running ? 'working' : chat.queue.length > 0 ? 'queued' : 'idle',
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
    expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 3 })
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
