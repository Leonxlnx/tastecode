import { describe, expect, it } from 'vitest'
import { DESIGN_BRIEF_ATTACHMENT, addDesignBriefing } from './briefing.js'

describe('design briefing mode', () => {
  it('marks a turn exactly once without changing its user-visible prompt', () => {
    expect(addDesignBriefing(['reference.png'])).toEqual(['reference.png', DESIGN_BRIEF_ATTACHMENT])
    expect(addDesignBriefing([DESIGN_BRIEF_ATTACHMENT])).toEqual([DESIGN_BRIEF_ATTACHMENT])
    expect(addDesignBriefing(['personal-harness://design-brief-v1'])).toEqual([
      DESIGN_BRIEF_ATTACHMENT,
    ])
  })
})
