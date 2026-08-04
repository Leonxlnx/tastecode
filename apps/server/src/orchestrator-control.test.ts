import { describe, expect, it, vi } from 'vitest'
import { Store } from './store.js'

const control = vi.hoisted(() => ({
  constructed: 0,
  started: 0,
  releases: [] as Array<() => void>,
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
      dispose(): void {}
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

describe('control adapter startup', () => {
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
    orchestrator.disposeAll()
  })
})
