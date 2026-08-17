// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'

import {
  PROMPT_PROGRESS_SCENARIOS,
  promptProgressDependencies,
  runPromptProgress,
} from './prompt-progress.fixture.js'
import { threadItems } from '../thread-store.js'

afterEach(cleanup)

describe('prompt progress lifecycle', () => {
  it.each(PROMPT_PROGRESS_SCENARIOS)('keeps one stable visible state for $name', (scenario) => {
    const run = runPromptProgress(scenario, promptProgressDependencies)

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
