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
  it.each([4 * 1024, 64 * 1024])(
    'keeps a %i-byte live reply outside the full Markdown parser',
    (size) => {
      const text = `${'Readable prose with **unfinished Markdown**.\n'.repeat(Math.ceil(size / 44)).slice(0, size)}\n\`\`\`ts\nconst pending =`
      const rendered = render(<Markdown text={text.slice(0, -8)} streaming />)
      const liveText = rendered.container.querySelector('[data-streaming-markdown]')
      const firstTextNode = liveText?.firstChild

      rendered.rerender(<Markdown text={text.slice(0, -4)} streaming />)
      expect(liveText?.firstChild).toBe(firstTextNode)
      rendered.rerender(<Markdown text={text} streaming />)

      expect(liveText?.textContent).toBe(text)
      expect(liveText?.firstChild).toBe(firstTextNode)
      expect(liveText?.childNodes).toHaveLength(1)
      expect(streamdownRender).not.toHaveBeenCalled()
      expect(plainHighlight).not.toHaveBeenCalled()
      expect(shikiHighlight).not.toHaveBeenCalled()
    },
  )

  it('parses and highlights the complete reply exactly once', () => {
    const text = '```ts\nconst value = 1\n```'
    const rendered = render(<Markdown text={text} streaming />)

    expect(streamdownRender).not.toHaveBeenCalled()
    expect(plainHighlight).not.toHaveBeenCalled()

    rendered.rerender(<Markdown text={text} />)
    expect(streamdownRender).toHaveBeenCalledTimes(1)
    expect(shikiHighlight).toHaveBeenCalledTimes(1)
  })
})
