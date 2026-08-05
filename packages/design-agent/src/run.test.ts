import { describe, expect, it } from 'vitest'
import { createDesignRunState, nextDesignPhase, parseDesignRunState } from './run.js'

describe('design run state', () => {
  it('starts at briefing and resumes at the first incomplete phase', () => {
    expect(createDesignRunState()).toMatchObject({ phase: 'brief', completed: [] })
    expect(nextDesignPhase(['brief', 'brand', 'page'])).toBe('assets')
    expect(
      nextDesignPhase(['brief', 'brand', 'page', 'assets', 'build', 'preview', 'review']),
    ).toBe('complete')
  })

  it('rejects skipped phases', () => {
    expect(() => nextDesignPhase(['brief', 'page'])).toThrow('contiguous prefix')
  })

  it('validates resumable failed state', () => {
    expect(
      parseDesignRunState({
        version: 1,
        phase: 'build',
        status: 'failed',
        completed: ['brief', 'brand', 'page', 'assets'],
        attempts: { build: 1, preview: 0, review: 0 },
        error: { phase: 'build', message: 'The project build failed.' },
      }),
    ).toMatchObject({ phase: 'build', status: 'failed' })
  })
})
