import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from './store.js'

const control = vi.hoisted(() => ({
  constructed: 0,
  started: 0,
  disposed: 0,
  releases: [] as Array<() => void>,
  usageChanged: undefined as (() => void) | undefined,
  login: undefined as
    | ((result: { loginId: string | null; success: boolean; error: string | null }) => void)
    | undefined,
}))

vi.mock('@harness/adapter-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-codex')>()
  return {
    ...original,
    CodexAdapter: class {
      constructor() {
        control.constructed += 1
      }

      on(
        event: string,
        listener: (result: {
          loginId: string | null
          success: boolean
          error: string | null
        }) => void,
      ): void {
        if (event === 'login') control.login = listener
      }
      onUsageChanged(listener: () => void): void {
        control.usageChanged = listener
      }
      dispose(): void {
        control.disposed += 1
      }
      listModels(): [] {
        return []
      }
      startLogin() {
        return { loginId: 'login-1', authUrl: 'https://example.test/login' }
      }

      start(): Promise<void> {
        control.started += 1
        return new Promise((resolve) => control.releases.push(resolve))
      }
    },
  }
})

import { Orchestrator } from './orchestrator.js'

beforeEach(() => {
  control.constructed = 0
  control.started = 0
  control.disposed = 0
  control.releases = []
  control.usageChanged = undefined
  control.login = undefined
})

describe('control adapter startup', () => {
  it('forwards the long-lived control adapter usage signal', async () => {
    const changed = vi.fn()
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      onUsageChanged: changed,
    })

    const started = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    await started
    control.usageChanged?.()

    expect(changed).toHaveBeenCalledWith('codex')
    await orchestrator.disposeAll()
  })

  it('ignores a control signal after disposal', async () => {
    const changed = vi.fn()
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      onUsageChanged: changed,
    })
    const started = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    await started

    await orchestrator.disposeAll()
    control.usageChanged?.()

    expect(changed).not.toHaveBeenCalled()
  })

  it('shares one startup across concurrent settings requests', async () => {
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
    })

    const first = orchestrator.listModels('codex')
    const second = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.started).toBe(1))

    expect(control.constructed).toBe(1)
    control.releases[0]?.()
    await expect(Promise.all([first, second])).resolves.toEqual([[], []])
    await orchestrator.disposeAll()
  })

  it('releases an idle control adapter and starts a fresh one for a later request', async () => {
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      controlIdleMs: 0,
    })

    const first = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    await first
    await vi.waitFor(() => expect(control.disposed).toBe(1))

    const second = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(2))
    control.releases[1]?.()
    await second
    await vi.waitFor(() => expect(control.disposed).toBe(2))

    expect(control.constructed).toBe(2)
    await orchestrator.disposeAll()
  })

  it('keeps the control adapter alive until an interactive login completes', async () => {
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
      controlIdleMs: 0,
    })

    const login = orchestrator.startLogin('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    await expect(login).resolves.toEqual({
      loginId: 'login-1',
      authUrl: 'https://example.test/login',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(control.disposed).toBe(0)

    control.login?.({ loginId: 'login-1', success: true, error: null })
    await vi.waitFor(() => expect(control.disposed).toBe(1))
    await orchestrator.disposeAll()
  })
})
