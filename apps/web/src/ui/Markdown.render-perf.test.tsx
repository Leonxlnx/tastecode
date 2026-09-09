// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const streamdownRender = vi.hoisted(() => vi.fn())
const shikiHighlight = vi.hoisted(() => vi.fn())

vi.mock('./highlighter.js', () => ({
  shikiPlugin: { highlight: shikiHighlight },
}))

vi.mock('streamdown', () => ({
  Streamdown: (props: {
    children: ReactNode
    controls: unknown
    plugins: { code: { highlight: (options: { code: string }) => unknown } }
    animated: unknown
    parseIncompleteMarkdown: boolean
  }) => {
    streamdownRender(props)
    props.plugins.code.highlight({ code: String(props.children) })
    return <div>{props.children}</div>
  },
}))

import { Markdown, needsRichMarkdown } from './Markdown.js'
import { LiveMarkdownParser } from './live-markdown.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  streamdownRender.mockReset()
  shikiHighlight.mockReset()
})

describe('streamed Markdown renders', () => {
  it('keeps plain completed prose on the lightweight renderer', () => {
    const rendered = render(<Markdown text="A short plain answer." />)

    expect(rendered.container.querySelector('[data-plain-markdown]')?.textContent).toBe(
      'A short plain answer.',
    )
    expect(streamdownRender).not.toHaveBeenCalled()
    expect(needsRichMarkdown('A short plain answer.')).toBe(false)
    expect(needsRichMarkdown('Use `pnpm test`.')).toBe(true)
    expect(needsRichMarkdown('- first\n- second')).toBe(true)
    expect(needsRichMarkdown('Heading\n===')).toBe(true)
    expect(needsRichMarkdown('Paragraph\n\n    indented code')).toBe(true)
    expect(needsRichMarkdown('Hard break  \nnext line')).toBe(true)
  })

  it('keeps plain completed paragraphs on the lightweight renderer', () => {
    const text = 'First plain paragraph.\n\nSecond plain paragraph.'
    const rendered = render(<Markdown text={text} />)

    expect([...rendered.container.querySelectorAll('p')].map((node) => node.textContent)).toEqual([
      'First plain paragraph.',
      'Second plain paragraph.',
    ])
    expect(needsRichMarkdown(text)).toBe(false)
    expect(streamdownRender).not.toHaveBeenCalled()
  })

  it('keeps ordinary punctuation and identifiers on the lightweight renderer', () => {
    const text =
      'Issue #123 keeps user_profile_1 in C:\\workspace\\project. The result [ready] is plain.'
    const rendered = render(<Markdown text={text} />)

    expect(rendered.container.querySelector('[data-plain-markdown]')?.textContent).toBe(text)
    expect(streamdownRender).not.toHaveBeenCalled()
    expect(needsRichMarkdown(text)).toBe(false)
    expect(needsRichMarkdown('One * marker and one _ marker stay literal.')).toBe(false)
    expect(needsRichMarkdown('Compare x < y and y > z.')).toBe(false)
  })

  it.each([
    ['inline code', 'Use `pnpm test`.'],
    ['emphasis', 'This is _important_.'],
    ['strong emphasis', 'This is **important**.'],
    ['link', 'Open [the docs](https://example.com).'],
    ['reference link', 'Open [the docs][docs].'],
    ['reference definition', '[docs]: https://example.com'],
    ['heading', '# Heading'],
    ['bullet', '* first'],
    ['ordered list', '1. first'],
    ['blockquote', '> quoted'],
    ['setext heading', 'Heading\n==='],
    ['indented code', 'Paragraph\n\n    const value = 1'],
    ['hard break', 'First line  \nsecond line'],
    ['table', 'Name | Value\n--- | ---\none | two'],
    ['strikethrough', 'This is ~~old~~.'],
    ['escaped punctuation', 'Keep \\* literal.'],
    ['escaped ampersand', 'Keep \\& literal.'],
    ['autolink', '<https://example.com>'],
    ['email autolink', '<user@example.com>'],
    ['raw HTML', '<strong>important</strong>'],
    ['HTML comment', '<!-- comment -->'],
    ['named character reference', 'Tom &amp; Jerry'],
    ['numeric character reference', 'Copyright &#169;'],
  ])('keeps %s on the rich renderer', (_label, text) => {
    expect(needsRichMarkdown(text)).toBe(true)
  })

  it.each([4 * 1024, 64 * 1024])(
    'parses only the appended suffix of a %i-character live reply',
    (size) => {
      const prefix = 'x'.repeat(size)
      const append = vi.spyOn(LiveMarkdownParser.prototype, 'append')
      const replace = vi.spyOn(LiveMarkdownParser.prototype, 'replace')
      const rendered = render(<Markdown text={prefix} streaming />)
      const paragraph = rendered.container.querySelector('p')

      expect(paragraph?.childNodes).toHaveLength(1)
      expect(rendered.container.querySelectorAll('[data-live-markdown-leaf]')).toHaveLength(0)

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
      expect(shikiHighlight).not.toHaveBeenCalled()
      expect(rendered.container.querySelectorAll('[data-live-markdown-leaf]')).toHaveLength(1)
      expect(paragraph?.childNodes.length).toBeLessThanOrEqual(2)
    },
  )

  it('parses only the suffix appended to a 64 KiB fenced-code tail', () => {
    const prefix = `\`\`\`ts\n${'x'.repeat(64 * 1024)}`
    const append = vi.spyOn(LiveMarkdownParser.prototype, 'append')
    const replace = vi.spyOn(LiveMarkdownParser.prototype, 'replace')
    const rendered = render(<Markdown text={prefix} streaming />)

    append.mockClear()
    replace.mockClear()
    rendered.rerender(
      <Markdown
        text={`${prefix}y`}
        streaming
        liveUpdate={{ kind: 'append', text: 'y' }}
        updateVersion={1}
      />,
    )

    expect(append).toHaveBeenCalledOnce()
    expect(append).toHaveBeenCalledWith('y')
    expect(replace).not.toHaveBeenCalled()
    expect(streamdownRender).not.toHaveBeenCalled()
    expect(shikiHighlight).not.toHaveBeenCalled()
    expect(rendered.container.querySelector('pre')?.textContent).toBe('x'.repeat(64 * 1024) + 'y')
  })

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

  it('parses and highlights the completed reply exactly once', async () => {
    const text = '```ts\nconst value = 1\n```'
    const rendered = render(<Markdown text={text} streaming />)

    expect(streamdownRender).not.toHaveBeenCalled()

    rendered.rerender(<Markdown text={text} />)
    await waitFor(() => expect(streamdownRender).toHaveBeenCalledTimes(1))
    expect(shikiHighlight).toHaveBeenCalledTimes(1)
    expect(streamdownRender.mock.calls[0]?.[0].parseIncompleteMarkdown).toBe(true)
  })
})
