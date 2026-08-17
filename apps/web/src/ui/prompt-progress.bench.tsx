// @vitest-environment happy-dom
import { afterEach, bench, describe } from 'vitest'
import { cleanup } from '@testing-library/react'

import {
  PROMPT_PROGRESS_SCENARIOS,
  promptProgressDependencies,
  runPromptProgress,
} from './prompt-progress.fixture.js'

afterEach(cleanup)

describe('prompt to first visible delta', () => {
  for (const scenario of PROMPT_PROGRESS_SCENARIOS) {
    bench(
      scenario.name,
      () => {
        const run = runPromptProgress(scenario, promptProgressDependencies)
        run.rendered.unmount()
      },
      { iterations: 20, warmupIterations: 5, time: 0, warmupTime: 0 },
    )
  }
})
