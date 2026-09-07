import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from './store.js'

const control = vi.hoisted(() => ({
  constructed: 0,
  started: 0,
  disposed: 0,
  disposeStarts: 0,
  disposeGate: undefined as Promise<void> | undefined,
  disposeError: undefined as Error | undefined,
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
      async dispose(): Promise<void> {
        control.disposeStarts += 1
        if (control.disposeGate) await control.disposeGate
        if (control.disposeError) throw control.disposeError
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
  control.disposeStarts = 0
  control.disposeGate = undefined
  control.disposeError = undefined
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

  it('waits for an in-flight control adapter to be disposed', async () => {
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: () => {},
      onLogin: () => {},
    })
    const started = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    let disposed = false

    const disposing = orchestrator.disposeAll().then(() => {
      disposed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(disposed).toBe(false)
    control.releases[0]?.()
    await expect(started).resolves.toEqual([])
    await disposing
    expect(control.disposed).toBe(1)
  })

  it('waits for idle disposal before starting a replacement', async () => {
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

    let releaseIdle!: () => void
    control.disposeGate = new Promise<void>((resolve) => {
      releaseIdle = resolve
    })
    try {
      await vi.waitFor(() => expect(control.disposeStarts).toBe(1))
      expect(control.disposed).toBe(0)

      const second = orchestrator.listModels('codex')
      let settled = false
      void second.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      // The replacement must not overlap the still-disposing process.
      expect(settled).toBe(false)
      expect(control.constructed).toBe(1)

      releaseIdle()
      await vi.waitFor(() => expect(control.releases).toHaveLength(2))
      control.releases[1]?.()
      await expect(second).resolves.toEqual([])
      expect(control.constructed).toBe(2)
      expect(control.disposed).toBe(1)
    } finally {
      control.disposeGate = undefined
      releaseIdle()
      await orchestrator.disposeAll()
    }
  })

  it('logs an idle disposal failure and still starts fresh', async () => {
    const logs: string[] = []
    const orchestrator = new Orchestrator(new Store(':memory:'), {
      onEvent: () => {},
      onLog: (line) => logs.push(line),
      onLogin: () => {},
      controlIdleMs: 0,
    })

    const first = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.releases).toHaveLength(1))
    control.releases[0]?.()
    await first

    control.disposeError = new Error('idle control close failed')
    try {
      await vi.waitFor(() => expect(control.disposeStarts).toBe(1))
      await vi.waitFor(() =>
        expect(logs.some((line) => line.includes('idle dispose failed'))).toBe(true),
      )
      expect(control.disposed).toBe(0)

      const second = orchestrator.listModels('codex')
      await vi.waitFor(() => expect(control.releases).toHaveLength(2))
      control.releases[1]?.()
      await expect(second).resolves.toEqual([])
      expect(control.constructed).toBe(2)
    } finally {
      control.disposeError = undefined
      await orchestrator.disposeAll()
    }
  })

  it('waits for an in-flight idle disposal during shutdown', async () => {
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

    let releaseIdle!: () => void
    control.disposeGate = new Promise<void>((resolve) => {
      releaseIdle = resolve
    })
    try {
      await vi.waitFor(() => expect(control.disposeStarts).toBe(1))
      let shutdownSettled = false
      const shutdown = orchestrator.disposeAll().then(
        () => {
          shutdownSettled = true
        },
        (error) => {
          shutdownSettled = true
          throw error
        },
      )
      void shutdown.catch(() => undefined)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(shutdownSettled).toBe(false)

      releaseIdle()
      await shutdown
      expect(control.disposed).toBe(1)
    } finally {
      control.disposeGate = undefined
      releaseIdle()
      await orchestrator.disposeAll().catch(() => undefined)
    }
  })
})
