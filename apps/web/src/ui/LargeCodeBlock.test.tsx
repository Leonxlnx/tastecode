// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CompletedMarkdown } from './CompletedMarkdown.js'
import type { HighlightResult } from './highlighter-protocol.js'

const mock = vi.hoisted(() => ({ highlight: vi.fn() }))
vi.mock('./highlighter.js', () => ({
  shikiPlugin: {
    type: 'code-highlighter',
    name: 'shiki',
    getThemes: () => ['github-light-default', 'github-dark-default'],
    highlight: mock.highlight,
  },
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mock.highlight.mockReset()
})

it('keeps all code selectable and copyable while worker colors paint in bounded batches', async () => {
  const callbacks = new Map<number, FrameRequestCallback>()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++next, callback)
    return next
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
  const code = Array.from(
    { length: 700 },
    (_, index) =>
      `${index % 8 ? '\t' : ''}const item${index} = 'text — 雪 ${index}'; // padding padding`,
  ).join('\n')
  let complete: ((result: HighlightResult) => void) | undefined
  mock.highlight.mockImplementation((_options, callback) => {
    complete = callback
    return { tokens: code.split('\n').map((content) => [{ content }]) }
  })
  const copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const view = render(<CompletedMarkdown text={`\`\`\`typescript\n${code}\n\`\`\``} />)
  const renderedCode = () =>
    [...view.container.querySelectorAll('.md-code-chunk')]
      .map((chunk) => {
        const lines = [...chunk.querySelectorAll('.md-code-line')]
        return lines.length ? lines.map((line) => line.textContent).join('\n') : chunk.textContent
      })
      .join('\n')
  expect(renderedCode()).toBe(code)
  fireEvent.click(screen.getByRole('button', { name: /copy/i }))
  expect(copied).toHaveBeenCalledWith(`${code}\n`)
  expect(view.container.querySelectorAll('span[style*="--sdm-c"]')).toHaveLength(0)
  expect(complete).toBeTypeOf('function')
  act(() =>
    complete!({
      tokens: code
        .split('\n')
        .map((content) => [
          { content, htmlStyle: { color: '#cf222e', '--shiki-dark': '#ff7b72' } },
        ]),
    }),
  )
  const frame = () =>
    act(() => {
      const ready = [...callbacks.values()]
      callbacks.clear()
      ready.forEach((callback) => callback(0))
    })
  frame()
  expect(view.container.querySelectorAll('span[style*="--sdm-c"]')).toHaveLength(12)
  expect(renderedCode()).toBe(code)
  expect(view.container.querySelector('[data-highlight-pending="true"]')).toBeTruthy()
  for (let count = 0; count < 60; count += 1) frame()
  expect(view.container.querySelectorAll('span[style*="--shiki-dark"]')).toHaveLength(700)
  expect(renderedCode()).toBe(code)
  expect(view.container.querySelector('[data-highlight-pending="true"]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /copy/i }))
  expect(copied).toHaveBeenCalledWith(`${code}\n`)
  expect(screen.getByRole('button', { name: /download/i })).toBeTruthy()
  view.unmount()
  expect(callbacks.size).toBe(0)
})

it.each(['```typescript extra', '~~~typescript', '```typescript'])(
  'preserves literal markup, whitespace and raw copy through %s fences',
  (opening) => {
    const code = `${'\tconst value = "<b>雪</b>"; // padding padding padding\n\n'.repeat(700)}`
    mock.highlight.mockImplementation(({ code }) => ({
      tokens: code.split('\n').map((content: string) => [{ content }]),
    }))
    const copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const closing = opening.startsWith('~~~') ? '~~~' : '```'
    const view = render(<CompletedMarkdown text={`${opening}\n${code}${closing}`} />)
    expect(view.container.querySelector('pre b')).toBeNull()
    const rendered = [...view.container.querySelectorAll('.md-code-chunk')]
      .map((chunk) => chunk.textContent)
      .join('\n')
    expect(rendered).toBe(code.replace(/\n+$/u, ''))
    expect(rendered.split('\n')).toHaveLength(1399)
    expect(rendered.split('\n')[0]).toBe('\tconst value = "<b>雪</b>"; // padding padding padding')
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(copied).toHaveBeenCalledWith(code)
    expect(view.container.querySelector('[data-highlight-pending="true"]')).toBeNull()
  },
)

it('ignores a late worker reply after a different completed fence replaces the block', () => {
  const callbacks: Array<(result: HighlightResult) => void> = []
  mock.highlight.mockImplementation(({ code }, callback) => {
    callbacks.push(callback)
    return { tokens: code.split('\n').map((content: string) => [{ content }]) }
  })
  const oldCode = 'const oldValue = "old"; // padding padding\n'.repeat(900)
  const newCode = 'const newValue = "new"; // padding padding\n'.repeat(900)
  const fence = (code: string) => `\`\`\`typescript\n${code}\`\`\``
  const view = render(<CompletedMarkdown text={fence(oldCode)} />)
  view.rerender(<CompletedMarkdown text={fence(newCode)} />)
  act(() => callbacks[0]!({ tokens: [[{ content: 'stale result', color: '#cf222e' }]] }))
  expect(view.container.querySelector('.md-code-chunk')?.textContent).toContain('newValue')
  expect(view.container.textContent).not.toContain('stale result')
})

it('inherits repeated foregrounds without dropping distinct styles or token attributes', () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const line = 'common foreground one; common foreground two; marked; background;'
  const code = Array(700).fill(line).join('\n')
  const common = { color: '#1f2328', '--shiki-dark': '#e6edf3' }
  mock.highlight.mockReturnValue({
    tokens: Array.from({ length: 700 }, () => [
      { content: 'common foreground one; ', htmlStyle: common },
      { content: 'common foreground two; ', htmlStyle: common },
      { content: 'marked; ', htmlStyle: common, htmlAttrs: { 'data-marked': 'kept' } },
      { content: 'background;', htmlStyle: common, bgColor: '#ffffff' },
    ]),
  })
  const view = render(<CompletedMarkdown text={`\`\`\`typescript\n${code}\n\`\`\``} />)
  act(() => frames.shift()!(0))
  const first = view.container.querySelector<HTMLElement>('.md-code-line')!
  expect(first.textContent).toBe(line)
  expect(first.style.getPropertyValue('--sdm-c')).toBe('#1f2328')
  expect(first.style.getPropertyValue('--shiki-dark')).toBe('#e6edf3')
  expect(first.children).toHaveLength(2)
  expect(first.childNodes).toHaveLength(3)
  expect(first.querySelector('[data-marked="kept"]')?.textContent).toBe('marked; ')
  expect(
    first.querySelector<HTMLElement>('span:last-child')?.style.getPropertyValue('--sdm-tbg'),
  ).toBe('#ffffff')
})
