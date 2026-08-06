// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'

const streamdownRender = vi.hoisted(() => vi.fn())

vi.mock('streamdown', () => ({
  Streamdown: (props: {
    children: ReactNode
    controls: unknown
    plugins: unknown
    animated: unknown
  }) => {
    streamdownRender(props)
    return <div>{props.children}</div>
  },
}))

import { Markdown } from './Markdown.js'

afterEach(() => {
  cleanup()
  streamdownRender.mockReset()
})

describe('streamed Markdown renders', () => {
  it('keeps Streamdown configuration stable while text grows', () => {
    const rendered = render(<Markdown text="First frame" streaming />)
    const first = streamdownRender.mock.calls.at(-1)?.[0]

    rendered.rerender(<Markdown text="First frame, next words" streaming />)
    const second = streamdownRender.mock.calls.at(-1)?.[0]

    expect(second.controls).toBe(first.controls)
    expect(second.plugins).toBe(first.plugins)
    expect(second.animated).toBe(first.animated)
  })
})
