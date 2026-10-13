// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeIndicatorRef } from './active-indicator.js'

function pill(top: number, left = 12) {
  const node = document.createElement('span')
  node.getBoundingClientRect = () => new DOMRect(left, top, 3, 14)
  const animate = vi.fn()
  node.animate = animate as unknown as HTMLElement['animate']
  return { node, animate }
}

function reducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches, media: query }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('activeIndicatorRef', () => {
  it('slides the new pill in from where the old one stood, in one commit', () => {
    reducedMotion(false)
    const from = pill(100, 1)
    const to = pill(160)
    activeIndicatorRef(from.node)?.()
    activeIndicatorRef(to.node)

    expect(to.animate).toHaveBeenCalledOnce()
    const [frames, timing] = to.animate.mock.calls[0]!
    expect(frames).toEqual([
      { transform: 'translate(-11px, -60px)' },
      { transform: 'translate(0, 0)' },
    ])
    expect(timing).toMatchObject({ duration: 220 })
  })

  it('does not slide a pill that only re-attached in place', () => {
    reducedMotion(false)
    const same = pill(100)
    activeIndicatorRef(same.node)?.()
    activeIndicatorRef(same.node)
    expect(same.animate).not.toHaveBeenCalled()
  })

  it('forgets a hand-over that did not complete in the same commit', async () => {
    reducedMotion(false)
    activeIndicatorRef(pill(100).node)?.()
    await Promise.resolve()
    const later = pill(400)
    activeIndicatorRef(later.node)
    expect(later.animate).not.toHaveBeenCalled()
  })

  it('jumps without motion when the user asks for reduced motion', () => {
    reducedMotion(true)
    activeIndicatorRef(pill(100).node)?.()
    const to = pill(160)
    activeIndicatorRef(to.node)
    expect(to.animate).not.toHaveBeenCalled()
  })
})
