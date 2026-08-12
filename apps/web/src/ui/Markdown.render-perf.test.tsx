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
import { LiveMarkdownParser } from './live-markdown.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  streamdownRender.mockReset()
  shikiHighlight.mockReset()
  plainHighlight.mockReset()
})

describe('streamed Markdown renders', () => {
  it.each([4 * 1024, 64 * 1024])(
    'parses only the appended suffix of a %i-character live reply',
    (size) => {
      const prefix = 'x'.repeat(size)
      const append = vi.spyOn(LiveMarkdownParser.prototype, 'append')
      const replace = vi.spyOn(LiveMarkdownParser.prototype, 'replace')
      const rendered = render(<Markdown text={prefix} streaming />)
      const paragraph = rendered.container.querySelector('p')

      append.mockClear()
      replace.mockClear()
      rendered.rerender(
        <Markdown
          text={`${prefix} next`}
          streaming
          liveUpdate={{ kind: 'append', text: ' next' }}
          updateVersion={1}
        />,
      )

      expect(rendered.container.querySelector('p')).toBe(paragraph)
      expect(rendered.container.textContent).toBe(`${prefix} next`)
      expect(append).toHaveBeenCalledOnce()
      expect(append).toHaveBeenCalledWith(' next')
      expect(replace).not.toHaveBeenCalled()
      expect(streamdownRender).not.toHaveBeenCalled()
      expect(plainHighlight).not.toHaveBeenCalled()
      expect(shikiHighlight).not.toHaveBeenCalled()
    },
  )

  it('applies each version once and resets mismatched reconciliation', () => {
    const append = vi.spyOn(LiveMarkdownParser.prototype, 'append')
    const replace = vi.spyOn(LiveMarkdownParser.prototype, 'replace')
    const rendered = render(<Markdown text="Old answer" streaming />)
    rendered.rerender(
      <Markdown
        text="Corrected **answer**"
        streaming
        liveUpdate={{ kind: 'reset', text: 'Corrected **answer**' }}
        updateVersion={1}
      />,
    )

    expect(rendered.container.textContent).toBe('Corrected answer')
    expect(rendered.container.querySelector('strong')).toBeTruthy()
    expect(streamdownRender).not.toHaveBeenCalled()

    replace.mockClear()
    rendered.rerender(
      <Markdown
        text="Corrected **answer** plus"
        streaming
        liveUpdate={{ kind: 'append', text: ' plus' }}
        updateVersion={2}
      />,
    )
    rendered.rerender(
      <Markdown
        text="Corrected **answer** plus"
        streaming
        liveUpdate={{ kind: 'append', text: ' plus' }}
        updateVersion={2}
      />,
    )
    expect(append).toHaveBeenCalledTimes(1)
    expect(rendered.container.textContent).toBe('Corrected answer plus')

    rendered.rerender(
      <Markdown
        text="Authoritative replacement"
        streaming
        liveUpdate={{ kind: 'append', text: 'wrong suffix' }}
        updateVersion={3}
      />,
    )
    expect(replace).toHaveBeenCalledWith('Authoritative replacement')
    expect(rendered.container.textContent).toBe('Authoritative replacement')
  })

  it('parses and highlights the completed reply exactly once', () => {
    const text = '```ts\nconst value = 1\n```'
    const rendered = render(<Markdown text={text} streaming />)

    expect(streamdownRender).not.toHaveBeenCalled()
    expect(plainHighlight).not.toHaveBeenCalled()

    rendered.rerender(<Markdown text={text} />)
    expect(streamdownRender).toHaveBeenCalledTimes(1)
    expect(shikiHighlight).toHaveBeenCalledTimes(1)
  })
})
