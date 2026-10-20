import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session } from './ui/Sidebar.js'

const bridge = vi.hoisted(() => ({ install: vi.fn<() => Promise<boolean>>() }))
vi.mock('./bridge.js', () => ({ installAppUpdate: bridge.install }))

import {
  appUpdateInstallState,
  cancelAppUpdateInstall,
  INSTALL_SETTLE_MS,
  reportRunningChats,
  requestAppUpdateInstall,
  resetAppUpdateInstallForTests,
  runningChatCount,
  serverRunningChatCount,
  setAppUpdateInstallGate,
  stopChatsAndInstall,
  waitingLabel,
} from './app-update-install.js'

function gate(running: number[] = [0]) {
  const answers = [...running]
  const calls: string[] = []
  const value = {
    calls,
    runningChats: vi.fn(async () => {
      calls.push('count')
      return answers.length > 1 ? answers.shift()! : answers[0]!
    }),
    stopRunningChats: vi.fn(async () => {
      calls.push('stop')
    }),
  }
  setAppUpdateInstallGate(value)
  return value
}

beforeEach(() => {
  vi.useFakeTimers()
  bridge.install.mockImplementation(async () => true)
})

afterEach(() => {
  resetAppUpdateInstallForTests()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('app update install', () => {
  it('installs at once when the server runs no chat', async () => {
    const server = gate([0])
    reportRunningChats(0)
    await requestAppUpdateInstall()
    expect(server.runningChats).toHaveBeenCalledOnce()
    expect(bridge.install).toHaveBeenCalledOnce()
    expect(appUpdateInstallState()).toEqual({ phase: 'installing' })
  })

  it('waits while chats run instead of installing', async () => {
    const server = gate([0])
    reportRunningChats(2)
    await requestAppUpdateInstall()
    expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 2 })
    reportRunningChats(1)
    expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 1 })
    await vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS * 4)
    expect(server.runningChats).not.toHaveBeenCalled()
    expect(bridge.install).not.toHaveBeenCalled()
  })

  it('installs by itself once the last running chat ends', async () => {
    const server = gate([0])
    reportRunningChats(2)
    await requestAppUpdateInstall()
    reportRunningChats(1)
    reportRunningChats(0)
    // A queued prompt starts the next turn a moment later; nothing installs before that.
    await vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS - 1)
    expect(bridge.install).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(server.runningChats).toHaveBeenCalledOnce()
    expect(bridge.install).toHaveBeenCalledOnce()
  })

  it('keeps waiting when the server still starts a queued turn', async () => {
    const server = gate([1, 0])
    reportRunningChats(1)
    await requestAppUpdateInstall()
    reportRunningChats(0)
    await vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS)
    expect(server.runningChats).toHaveBeenCalledOnce()
    expect(bridge.install).not.toHaveBeenCalled()
    expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 1 })
    // The queued turn's status arrives, then that turn ends too.
    reportRunningChats(1)
    reportRunningChats(0)
    await vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS)
    expect(server.runningChats).toHaveBeenCalledTimes(2)
    expect(bridge.install).toHaveBeenCalledOnce()
  })

  it('looks again while only the server knows a chat still runs', async () => {
    const server = gate([1, 1, 0])
    reportRunningChats(0)
    await requestAppUpdateInstall()
    expect(appUpdateInstallState()).toEqual({ phase: 'waiting', running: 1 })
    await vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS)
    expect(server.runningChats).toHaveBeenCalledTimes(2)
    expect(bridge.install).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS * 2)
    expect(server.runningChats).toHaveBeenCalledTimes(3)
    expect(bridge.install).toHaveBeenCalledOnce()
  })

  it('stops the running chats first when the user installs now', async () => {
    const server = gate([0])
    bridge.install.mockImplementation(async () => {
      server.calls.push('install')
      return true
    })
    reportRunningChats(2)
    await requestAppUpdateInstall()
    const stopping = stopChatsAndInstall()
    expect(appUpdateInstallState()).toEqual({ phase: 'stopping', running: 2 })
    await stopping
    expect(server.calls).toEqual(['stop', 'install'])
    expect(appUpdateInstallState()).toEqual({ phase: 'installing' })
  })

  it('still installs now when stopping the chats fails', async () => {
    const server = gate([0])
    server.stopRunningChats.mockRejectedValueOnce(new Error('socket closed'))
    reportRunningChats(1)
    await requestAppUpdateInstall()
    await stopChatsAndInstall()
    expect(server.stopRunningChats).toHaveBeenCalledOnce()
    expect(bridge.install).toHaveBeenCalledOnce()
  })

  it('stops waiting on Install later', async () => {
    gate([0])
    reportRunningChats(1)
    await requestAppUpdateInstall()
    cancelAppUpdateInstall()
    reportRunningChats(0)
    await vi.advanceTimersByTimeAsync(INSTALL_SETTLE_MS * 4)
    expect(appUpdateInstallState()).toEqual({ phase: 'idle' })
    expect(bridge.install).not.toHaveBeenCalled()
  })

  it('reports a failed install and forgets it on Install later', async () => {
    gate([0])
    bridge.install.mockResolvedValueOnce(false)
    await requestAppUpdateInstall()
    expect(appUpdateInstallState()).toEqual({ phase: 'idle', failed: true })
    cancelAppUpdateInstall()
    expect(appUpdateInstallState()).toEqual({ phase: 'idle' })
  })

  it('installs as before when the server cannot be asked', async () => {
    const server = gate([0])
    server.runningChats.mockRejectedValueOnce(new Error('offline'))
    await requestAppUpdateInstall()
    expect(bridge.install).toHaveBeenCalledOnce()
    resetAppUpdateInstallForTests()
    bridge.install.mockClear()
    await requestAppUpdateInstall()
    expect(bridge.install).toHaveBeenCalledOnce()
  })
})

describe('running chats', () => {
  const session = (id: string, status: Session['status']): Session => ({
    id,
    title: id,
    provider: 'codex',
    createdAt: 1,
    status,
    lifecycle: { state: 'active', keepActive: false },
    unread: false,
  })

  it('counts every chat inside a turn or starting one, once per chat', () => {
    const projects: Project[] = [
      {
        path: 'a',
        sessions: [
          session('working', 'working'),
          session('starting', 'starting'),
          session('approval', 'approval'),
          session('question', 'input'),
          session('queued', 'queued'),
          session('done', 'ready'),
          session('idle', 'idle'),
          session('failed', 'failed'),
        ],
      },
      { path: 'b', sessions: [session('working', 'working')] },
    ]
    expect(runningChatCount(projects)).toBe(4)
    expect(
      serverRunningChatCount([
        {
          sessions: [
            { id: 'a', running: true, status: 'idle' },
            { id: 'b', running: false, status: 'queued' },
            { id: 'c', running: false, status: 'ready' },
            { id: 'd', running: false },
            { id: 'e', running: true, status: 'approval' },
            { id: 'f', running: false, status: 'input' },
            { id: 'g', running: false, status: 'starting' },
          ],
        },
      ]),
    ).toBe(4)
  })

  it('does not count a chat that only holds queued prompts', () => {
    // After a restart, or after the server could not start the next prompt,
    // the prompts wait and no turn runs; they come back after the update.
    expect(runningChatCount([{ path: 'a', sessions: [session('stale', 'queued')] }])).toBe(0)
    expect(
      serverRunningChatCount([{ sessions: [{ id: 'stale', running: false, status: 'queued' }] }]),
    ).toBe(0)
  })

  it('words the wait for one chat and for several', () => {
    expect(waitingLabel(1)).toBe('Installs when 1 chat finishes')
    expect(waitingLabel(2)).toBe('Installs when 2 chats finish')
  })
})
