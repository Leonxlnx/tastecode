// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'

const streamdownRender = vi.hoisted(() => vi.fn())
const shikiHighlight = vi.hoisted(() => vi.fn())
const plainHighlight = vi.hoisted(() => vi.fn())

vi.mock('./highlighter.js', () => ({
  onHighlighterChange: () => () => undefined,
  shikiPlugin: { highlight: shikiHighlight },
  plainCodePlugin: { highlight: plainHighlight },
}))

vi.mock('streamdown', () => ({
  Streamdown: (props: {
    children: ReactNode
    controls: unknown
    plugins: { code: { highlight: (options: { code: string }) => unknown } }
    animated: unknown
  }) => {
    streamdownRender(props)
    props.plugins.code.highlight({ code: String(props.children) })
    return <div>{props.children}</div>
  },
}))

import { Markdown } from './Markdown.js'

afterEach(() => {
  cleanup()
  streamdownRender.mockReset()
  shikiHighlight.mockReset()
  plainHighlight.mockReset()
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

  it('defers syntax highlighting until streamed code completes', () => {
    const rendered = render(<Markdown text={'```ts\nconst value ='} streaming />)
    rendered.rerender(<Markdown text={'```ts\nconst value = 1\n```'} streaming />)

    expect(plainHighlight).toHaveBeenCalledTimes(2)
    expect(shikiHighlight).not.toHaveBeenCalled()

    rendered.rerender(<Markdown text={'```ts\nconst value = 1\n```'} />)
    expect(shikiHighlight).toHaveBeenCalledTimes(1)
  })
})
