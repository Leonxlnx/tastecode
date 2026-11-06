import { describe, expect, it } from 'vitest'
import { WEBSITE_MOTION_MODE, websiteMotion, type WebsiteMotionMode } from './website-motion.js'

describe('website motion', () => {
  it('defaults to the hybrid: the hover layer, one hero load motion and one moment, no reveals', () => {
    expect(WEBSITE_MOTION_MODE).toBe('hybrid')
    const { guidance, pagePlan, build, buildSource, review } = websiteMotion()
    expect(guidance).toContain('One load motion in the hero on every kind')
    expect(guidance).toContain('One creative moment in its own section on every kind')
    expect(guidance).toContain('never WebGL, a canvas shader or an animation library')
    expect(guidance).toContain('No card, row, tile, heading or photograph reveals')
    expect(guidance).toContain(
      'Under prefers-reduced-motion the load motion and the moment show their finished frame',
    )
    // tasteskill's own numbers come quoted, not paraphrased.
    expect(guidance).toContain('## The hover layer')
    expect(guidance).toContain('## Tech budget')
    expect(guidance).not.toContain('## Scroll')
    expect(pagePlan).toContain('exactly one section the creative moment')
    expect(build).toContain('Do not add scroll reveals')
    expect(buildSource).toBe('')
    expect(review).toContain('a missing or generic creative moment')
  })

  it('keeps the earlier reveals and tasteskill as written one value away', () => {
    const reveals = websiteMotion('reveals')
    expect(reveals.guidance).toContain('distinct scroll-triggered reveals for at least two later')
    expect(reveals.buildSource).toContain('installReferenceReveals')

    const tasteskill = websiteMotion('tasteskill')
    expect(tasteskill.guidance).toContain('on an other page nothing moves by itself')
    expect(tasteskill.guidance).toContain('## Scroll')
    expect(tasteskill.guidance).not.toContain('One creative moment')
    expect(tasteskill.build).toContain('on a tech page, its loops, count and moments')
    expect(tasteskill.build).not.toContain('creative moment')

    for (const mode of ['hybrid', 'tasteskill', 'reveals'] satisfies WebsiteMotionMode[]) {
      const motion = websiteMotion(mode)
      for (const text of [motion.guidance, motion.pagePlan, motion.build, motion.review])
        expect(text.length, mode).toBeGreaterThan(80)
    }
  })
})
