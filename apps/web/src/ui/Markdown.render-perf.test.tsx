// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render as renderView } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import {
  defaultMarkdownServices,
  Markdown,
  MarkdownServicesProvider,
  type MarkdownServices,
} from './Markdown.js'
import { plainCodePlugin } from './highlighter.js'
import { LiveMarkdownParser } from './live-markdown.js'

const completedRender = vi.fn()
const markdownServices: MarkdownServices = {
  ...defaultMarkdownServices,
  codePlugin: plainCodePlugin,
  onCompletedRender: completedRender,
}

function Services({ children }: { children: ReactNode }) {
  return <MarkdownServicesProvider services={markdownServices}>{children}</MarkdownServicesProvider>
}

function render(view: ReactElement) {
  return renderView(view, { wrapper: Services })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  completedRender.mockReset()
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
      expect(completedRender).not.toHaveBeenCalled()
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
    expect(completedRender).not.toHaveBeenCalled()
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
    expect(completedRender).not.toHaveBeenCalled()

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

  it('parses and renders the completed reply exactly once', () => {
    const text = '```ts\nconst value = 1\n```'
    const rendered = render(<Markdown text={text} streaming />)

    expect(completedRender).not.toHaveBeenCalled()

    rendered.rerender(<Markdown text={text} />)
    expect(completedRender).toHaveBeenCalledTimes(1)
    expect(rendered.container.querySelector('pre code')?.textContent).toContain('const value = 1')
  })
})
