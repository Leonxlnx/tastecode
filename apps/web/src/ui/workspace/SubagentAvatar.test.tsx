// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SubagentAvatar, sigilFor } from './SubagentAvatar.js'

afterEach(cleanup)

describe('sub-agent sigils', () => {
  it('draws the same sigil for the same sub-agent, every time', () => {
    expect(sigilFor('item-42')).toEqual(sigilFor('item-42'))
  })

  it('spreads the sub-agents of a chat over families and hues', () => {
    const sigils = Array.from({ length: 40 }, (_, index) => sigilFor(`call_${index}`))
    expect(new Set(sigils.map((sigil) => sigil.family)).size).toBe(5)
    expect(new Set(sigils.map((sigil) => sigil.hue)).size).toBeGreaterThanOrEqual(8)
  })

  it('draws every family as shapes on the two sigil tones, and marks a running one', () => {
    const families = new Set<string>()
    for (let index = 0; families.size < 5 && index < 200; index += 1) {
      const seed = `seed-${index}`
      const family = sigilFor(seed).family
      if (families.has(family)) continue
      families.add(family)
      const { container, unmount } = render(
        <SubagentAvatar seed={seed} running={index % 2 === 0} />,
      )
      const avatar = container.querySelector('.subagent-avatar')!
      expect(avatar.getAttribute('data-family')).toBe(family)
      expect(avatar.getAttribute('aria-hidden')).toBe('true')
      expect(avatar.hasAttribute('data-running')).toBe(index % 2 === 0)
      const shapes = [...avatar.querySelectorAll('svg > *')]
      expect(shapes.length).toBeGreaterThanOrEqual(2)
      for (const shape of shapes) {
        const paint = shape.getAttribute('fill') === 'none' ? 'stroke' : 'fill'
        expect(shape.getAttribute(paint)).toMatch(/^var\(--sigil-[ab]\)$/)
      }
      unmount()
    }
    expect(families.size).toBe(5)
  })
})
