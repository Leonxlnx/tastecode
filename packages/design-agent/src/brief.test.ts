import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDesignBrief, writeDesignBrief } from './brief.js'

const brief = {
  originalRequest: 'Create a studio site.',
  subject: 'Independent creative studio',
  pageType: 'Marketing site',
  scope: 'Single responsive page',
  primaryGoal: 'Generate qualified enquiries',
  audience: 'Teams seeking creative direction',
  offer: 'Brand and digital design services',
  primaryAction: 'Start a project',
  requiredContent: ['Selected work'],
  constraints: [],
  brandInputs: ['Use the supplied wordmark'],
  creativeControl: 'Agent-led',
  explicitAnswers: [{ question: 'Primary action?', answer: 'Start a project' }],
  assumptions: [],
  unresolved: [],
}

describe('design brief handoff', () => {
  it('round-trips the validated brief for the brand phase', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-design-'))
    try {
      expect(writeDesignBrief(workspace, brief)).toEqual(brief)
      expect(readDesignBrief(workspace)).toEqual(brief)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects an incomplete handoff', () => {
    expect(() => writeDesignBrief('ignored', { subject: 'Studio' })).toThrow(
      'design brief field originalRequest must be a non-empty string',
    )
  })
})
