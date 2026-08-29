import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from './store.js'

const control = vi.hoisted(() => ({
  constructed: 0,
  started: 0,
  disposed: 0,
  releases: [] as Array<() => void>,
  usageChanged: undefined as (() => void) | undefined,
}))

vi.mock('@harness/adapter-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-codex')>()
  return {
    ...original,
    CodexAdapter: class {
      constructor() {
        control.constructed += 1
      }

      on(): void {}
      onUsageChanged(listener: () => void): void {
        control.usageChanged = listener
      }
      dispose(): void {
        control.disposed += 1
      }
      listModels(): [] {
        return []
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
})
