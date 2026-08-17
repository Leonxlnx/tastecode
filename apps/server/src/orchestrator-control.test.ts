import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from '@harness/adapter-codex'
import { Store } from './store.js'
import { Orchestrator } from './orchestrator.js'

type ControlState = {
  constructed: number
  started: number
  releases: Array<() => void>
  usageChanged?: (() => void) | undefined
}

const control: ControlState = {
  constructed: 0,
  started: 0,
  releases: [],
  usageChanged: undefined,
}

class TestControlAdapter extends CodexAdapter {
  constructor() {
    super()
    control.constructed += 1
  }

  override onUsageChanged(listener: () => void): void {
    control.usageChanged = listener
  }
  override dispose(): void {}
  override async listModels() {
    return []
  }

  override start(): Promise<void> {
    control.started += 1
    return new Promise((resolve) => control.releases.push(resolve))
  }
}

const createControlAdapter = () => new TestControlAdapter()

beforeEach(() => {
  control.constructed = 0
  control.started = 0
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
      createCodexAdapter: createControlAdapter,
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
      createCodexAdapter: createControlAdapter,
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
      createCodexAdapter: createControlAdapter,
    })

    const first = orchestrator.listModels('codex')
    const second = orchestrator.listModels('codex')
    await vi.waitFor(() => expect(control.started).toBe(1))

    expect(control.constructed).toBe(1)
    control.releases[0]?.()
    await expect(Promise.all([first, second])).resolves.toEqual([[], []])
    await orchestrator.disposeAll()
  })
})
