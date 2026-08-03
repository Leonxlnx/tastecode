import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESIGN_BRIEF_ATTACHMENT,
  designBriefingPrompt,
  persistDesignBriefing,
  shouldEmitBriefingAgentMessage,
} from './design-briefing.js'

describe('design briefing prompt', () => {
  it('keeps structured output hidden until the friendly final item', () => {
    expect(shouldEmitBriefingAgentMessage('started')).toBe(false)
    expect(shouldEmitBriefingAgentMessage('delta')).toBe(false)
    expect(shouldEmitBriefingAgentMessage('completed', 'commentary')).toBe(false)
    expect(shouldEmitBriefingAgentMessage('completed', 'final_answer')).toBe(true)
  })

  it('keeps the workflow in briefing mode and preserves the user request', () => {
    const prompt = designBriefingPrompt('Design a launch page for a research tool.')

    expect(DESIGN_BRIEF_ATTACHMENT).toBe('personal-harness://design-brief-v1')
    expect(prompt).toContain('request_user_input')
    expect(prompt).toContain('If no material questions remain, do not call request_user_input')
    expect(prompt).toContain('there is no total question limit')
    expect(prompt).toContain('four, five, six, seven, eight, or more questions')
    expect(prompt).toContain('If an answer is vague, contradictory, or does not settle the field')
    expect(prompt).toContain(
      "Before I finalize your brief, is there anything else you'd like me to know?",
    )
    expect(prompt).toContain("No, that's everything")
    expect(prompt).toContain('If you asked no earlier questions, skip this final check')
    expect(prompt).toContain('do not force the user to choose fonts, colors, or visual details')
    expect(prompt).not.toContain('exactly one batch')
    expect(prompt).toContain('Design a launch page for a research tool.')
    expect(prompt).toContain('Do not use shell, patch, or filesystem tools')
    expect(prompt).toContain('Personal Harness will write .taste/brief.json')
  })

  it('persists only the structured brief and returns the debug stop', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'harness-brief-'))
    try {
      const message = persistDesignBriefing(
        JSON.stringify({
          status: 'complete',
          message: 'Brief complete.',
          brief: {
            originalRequest: 'Design a research workspace.',
            subject: 'Research workspace',
            pageType: 'Product interface',
            scope: 'Single responsive workspace',
            primaryGoal: 'Help researchers organize evidence',
            audience: 'Independent researchers',
            offer: 'A focused research workspace',
            primaryAction: 'Create a workspace',
            requiredContent: [],
            constraints: [],
            brandInputs: [],
            creativeControl: 'Agent-led',
            explicitAnswers: [],
            assumptions: ['Creative direction is open.'],
            unresolved: [],
          },
        }),
        workspace,
      )

      expect(message).toBe('Brief complete.\nDEBUG FINISHED · NO WEBSITE BUILT')
      expect(
        JSON.parse(readFileSync(path.join(workspace, '.taste', 'brief.json'), 'utf8')),
      ).toEqual({
        originalRequest: 'Design a research workspace.',
        subject: 'Research workspace',
        pageType: 'Product interface',
        scope: 'Single responsive workspace',
        primaryGoal: 'Help researchers organize evidence',
        audience: 'Independent researchers',
        offer: 'A focused research workspace',
        primaryAction: 'Create a workspace',
        requiredContent: [],
        constraints: [],
        brandInputs: [],
        creativeControl: 'Agent-led',
        explicitAnswers: [],
        assumptions: ['Creative direction is open.'],
        unresolved: [],
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
