// @vitest-environment happy-dom
import { afterEach, bench, describe, vi } from 'vitest'
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
        size: 72,
        lane: 0,
      }
    })
    return {
      getVirtualItems: () => rows,
      getTotalSize: () => count * 72,
      getOffsetForIndex: (index: number) => [index * 72],
      getScrollElement: () => null,
      scrollToIndex: () => undefined,
      measureElement: () => undefined,
      measurementsCache: rows,
    }
  },
}))

vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => <span aria-label="Working…" /> }))
vi.mock('./highlighter.js', () => {
  const plugin = {
    type: 'code-highlighter',
    name: 'prompt-progress-highlighter',
    getSupportedLanguages: () => [],
    getThemes: () => [],
    supportsLanguage: () => true,
    highlight: () => ({ tokens: [] }),
  }
  return {
    onHighlighterChange: () => () => undefined,
    shikiPlugin: plugin,
    plainCodePlugin: plugin,
  }
})

import { PROMPT_PROGRESS_SCENARIOS, runPromptProgress } from './prompt-progress.fixture.js'

afterEach(cleanup)

describe('prompt to first visible delta', () => {
  for (const scenario of PROMPT_PROGRESS_SCENARIOS) {
    bench(
      scenario.name,
      () => {
        const run = runPromptProgress(scenario)
        run.rendered.unmount()
      },
      { iterations: 20, warmupIterations: 5, time: 0, warmupTime: 0 },
    )
  }
})
