// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STAGE_GLIDE_ANIMATION_ID, useStageGlide } from './stage-glide.js'

type Box = { left: number; width: number }

let stageBox: Box
let reduceMotion: boolean
const animations: Array<{ target: Element; keyframes: Keyframe[]; options: unknown }> = []
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
const originalRect = Element.prototype.getBoundingClientRect

function Pane(props: { layout: string }) {
  const stage = useRef<HTMLElement>(null)
  useStageGlide(stage, props.layout)
  return (
    <div className="shell__body">
      <main className="stage" ref={stage}>
        <div className="stage__body">
          <div className="stage__conversation" />
        </div>
      </main>
    </div>
  )
}

function from(target: string): string | undefined {
  const animation = animations.find((entry) => (entry.target as HTMLElement).matches(target))
  return animation?.keyframes[0]?.['transform'] as string | undefined
}

beforeEach(() => {
  stageBox = { left: 256, width: 1144 }
  reduceMotion = false
  animations.length = 0
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const box = this.classList.contains('stage') ? stageBox : { left: 0, width: 0 }
    return {
      x: box.left,
      y: 0,
      top: 0,
      left: box.left,
      right: box.left + box.width,
      bottom: 800,
      width: box.width,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect
  }
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: function (this: Element, keyframes: Keyframe[], options: unknown) {
      animations.push({ target: this, keyframes, options })
      return {
        id: '',
        cancel: vi.fn(),
        finished: new Promise<void>(() => undefined),
      } as unknown as Animation
    },
  })
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce') && reduceMotion,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
})

afterEach(() => {
  cleanup()
  Element.prototype.getBoundingClientRect = originalRect
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(Element.prototype, 'animate')
  vi.unstubAllGlobals()
})

describe('stage glide', () => {
  it('rides the folding rail and carries the chat column to its new centre', () => {
    const view = render(<Pane layout="rail-open" />)
    expect(animations).toHaveLength(0)

    stageBox = { left: 0, width: 1400 }
    view.rerender(<Pane layout="rail-folded" />)

    // The pane's edge starts on the rail's edge; the column, already carried
    // that far by the pane, goes back half of it to stay where it was.
    expect(from('.stage')).toBe('translate3d(256px, 0, 0)')
    expect(from('.stage__conversation')).toBe('translate3d(-128px, 0, 0)')
    expect(animations[0]?.options).toEqual({
      duration: 260,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
    })
    expect(animations[0]?.keyframes[1]).toEqual({ transform: 'translate3d(0, 0, 0)' })
    // Compositor-only: no layout property is ever animated.
    expect(
      animations.flatMap((entry) => entry.keyframes.flatMap((frame) => Object.keys(frame))),
    ).toEqual(['transform', 'transform', 'transform', 'transform'])
    expect(view.container.querySelector('.shell__body')?.hasAttribute('data-stage-gliding')).toBe(
      true,
    )
    expect(STAGE_GLIDE_ANIMATION_ID).toBe('harness-stage-glide')
  })

  it('moves only the chat column when the side panel takes the right edge', () => {
    const view = render(<Pane layout="panel-hidden" />)

    stageBox = { left: 256, width: 624 }
    view.rerender(<Pane layout="panel-open" />)

    expect(from('.stage')).toBeUndefined()
    expect(from('.stage__conversation')).toBe('translate3d(260px, 0, 0)')
  })

  it('stays still under reduced motion', () => {
    reduceMotion = true
    const view = render(<Pane layout="rail-open" />)

    stageBox = { left: 0, width: 1400 }
    view.rerender(<Pane layout="rail-folded" />)

    expect(animations).toHaveLength(0)
    expect(view.container.querySelector('.shell__body')?.hasAttribute('data-stage-gliding')).toBe(
      false,
    )
  })

  it('does not glide a pane an expanded or narrow-layout panel hides', () => {
    const view = render(<Pane layout="panel-open" />)

    stageBox = { left: 256, width: 0 }
    view.rerender(<Pane layout="panel-open panel-expanded" />)

    expect(animations).toHaveLength(0)
  })

  it('does not glide when the box did not change', () => {
    const view = render(<Pane layout="rail-open" />)

    view.rerender(<Pane layout="rail-open panel-hidden" />)

    expect(animations).toHaveLength(0)
  })
})
