// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number
    getItemKey: (index: number) => string | number
  }) => {
    const first = Math.max(0, count - 20)
    const rows = Array.from({ length: count - first }, (_, offset) => {
      const index = first + offset
      return {
        index,
        key: getItemKey(index),
        start: index * 72,
        end: (index + 1) * 72,
      }
    })
    return {
      getVirtualItems: () => rows,
      getTotalSize: () => count * 72,
      getOffsetForIndex: (index: number) => [index * 72, 'start'],
      scrollToIndex: () => undefined,
      measureElement: () => undefined,
      measurementsCache: Array.from({ length: count }, (_, index) => ({ start: index * 72 })),
    }
  },
}))

import { PROMPT_PROGRESS_SCENARIOS, runPromptProgress } from './prompt-progress.fixture.js'
import { threadItems } from '../thread-store.js'

/** happy-dom's emulated device. The fixture reads the live reply right after
 * each delta, so text lands as it arrives instead of being paced over frames. */
const device = (
  window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } }
).happyDOM.settings.device

beforeEach(() => {
  device.prefersReducedMotion = 'reduce'
})

afterEach(() => {
  cleanup()
  device.prefersReducedMotion = 'no-preference'
})

describe('prompt progress lifecycle', () => {
  it.each(PROMPT_PROGRESS_SCENARIOS)('keeps one stable visible state for $name', (scenario) => {
    const run = runPromptProgress(scenario)

    expect(run.canonicalPrompt).toBe(run.optimisticPrompt)
    expect(run.startedPrompt).toBe(run.optimisticPrompt)
    expect(run.deltaPrompt).toBe(run.optimisticPrompt)
    expect(run.canonicalRail).toBe(run.optimisticRail)
    expect(run.deltaReply).toBe(run.startedReply)
    expect(run.rendered.container.querySelectorAll('.activity--duration')).toHaveLength(1)
    expect(threadItems(run.finalState).at(-1)?.text).toHaveLength(scenario.liveCharacters)
    expect(run.deltaReply.textContent).toHaveLength(scenario.liveCharacters)

    run.rendered.unmount()
  })
})
