import { describe, expect, it } from 'vitest'
import { DESIGN_BRIEF_ATTACHMENT, designBriefingPrompt } from './design-briefing.js'

describe('design briefing prompt', () => {
  it('keeps the workflow in briefing mode and preserves the user request', () => {
    const prompt = designBriefingPrompt('Design a launch page for a research tool.')

    expect(DESIGN_BRIEF_ATTACHMENT).toBe('personal-harness://design-brief-v1')
    expect(prompt).toContain('request_user_input')
    expect(prompt).toContain('Design a launch page for a research tool.')
    expect(prompt).toContain('DEBUG FINISHED · NO WEBSITE BUILT')
    expect(prompt).toContain('Create no other file.')
  })
})
