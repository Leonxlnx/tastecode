// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { threadItems } from '../thread-store.js'

afterEach(cleanup)

describe('prompt progress lifecycle', () => {
  it.each(PROMPT_PROGRESS_SCENARIOS)('keeps one stable visible state for $name', (scenario) => {
    const run = runPromptProgress(scenario)

    expect(run.canonicalPrompt).toBe(run.optimisticPrompt)
    expect(run.startedPrompt).toBe(run.optimisticPrompt)
    expect(run.deltaPrompt).toBe(run.optimisticPrompt)
    expect(run.canonicalRail).toBe(run.optimisticRail)
    expect(run.deltaReply).toBe(run.startedReply)
    expect(run.rendered.container.querySelectorAll('.activity--working')).toHaveLength(0)
    expect(threadItems(run.finalState).at(-1)?.text).toHaveLength(scenario.liveCharacters)
    expect(run.deltaReply.textContent).toHaveLength(scenario.liveCharacters)

    run.rendered.unmount()
  })
})
