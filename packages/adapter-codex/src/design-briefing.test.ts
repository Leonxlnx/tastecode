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
    expect(prompt).toContain(
      'exactly one batch containing two or three short, high-value questions',
    )
    expect(prompt).toContain("Anything else you'd like us to know?")
    expect(prompt).toContain("No, that's everything")
    expect(prompt).toContain('Only if an answer is genuinely ambiguous')
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
          brief: { subject: 'Research workspace', assumptions: ['Creative direction is open.'] },
        }),
        workspace,
      )

      expect(message).toBe('Brief complete.\nDEBUG FINISHED · NO WEBSITE BUILT')
      expect(
        JSON.parse(readFileSync(path.join(workspace, '.taste', 'brief.json'), 'utf8')),
      ).toEqual({
        subject: 'Research workspace',
        assumptions: ['Creative direction is open.'],
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
