// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { useListMotion } from './inbox-sidebar-motion.js'

const originalAnimate = HTMLElement.prototype.animate

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  HTMLElement.prototype.animate = originalAnimate
})

function List(props: { keys: string[]; revision?: number }) {
  const list = useRef<HTMLUListElement>(null)
  useListMotion(list, props.keys.join(','))
  return (
    <ul ref={list} data-revision={props.revision}>
      {props.keys.map((key) => (
        <li key={key} data-motion-key={key}>
          {key}
        </li>
      ))}
    </ul>
  )
}

describe('thread list motion', () => {
  it('slides moved rows, fades in new keys, and ignores commits that keep the order', () => {
    // Layout stand-in: each row sits 10px below the previous one.
    let reads = 0
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      reads += 1
      return [...(this.parentElement?.children ?? [])].indexOf(this) * 10
    })
    const animate = vi.fn()
    HTMLElement.prototype.animate = animate

    const { rerender } = render(<List keys={['a:card', 'b:card', 'c:card']} />)
    expect(animate).not.toHaveBeenCalled()

    // b settles: its card leaves and a settled row arrives at the end.
    rerender(<List keys={['a:card', 'c:card', 'b:row']} />)
    const calls = animate.mock.calls.map(([keyframes], index) => ({
      key: (animate.mock.contexts[index] as HTMLElement).dataset['motionKey'],
      from: (keyframes as Keyframe[])[0],
    }))
    expect(calls).toEqual([
      { key: 'c:card', from: { transform: 'translateY(10px)' } },
      { key: 'b:row', from: { opacity: 0, transform: 'translateY(10px)' } },
    ])

    reads = 0
    rerender(<List keys={['a:card', 'c:card', 'b:row']} revision={1} />)
    expect(reads).toBe(0)
  })
})
