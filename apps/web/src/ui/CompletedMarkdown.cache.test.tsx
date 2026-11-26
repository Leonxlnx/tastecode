// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { CompletedMarkdown } from './CompletedMarkdown.js'
import { createFinishedBlockCache } from './finished-block-cache.js'

const controls = vi.hoisted(() => ({ bypass: false, split: vi.fn() }))
vi.mock('./finished-block-cache.js', async (original) => {
  const actual = await original<typeof import('./finished-block-cache.js')>()
  return {
    ...actual,
    finishedBlocks: (text: string, split: (text: string) => string[]) =>
      controls.bypass ? split(text) : actual.finishedBlocks(text, split),
  }
})
vi.mock('./markdown-blocks.js', async (original) => {
  const actual = await original<typeof import('./markdown-blocks.js')>()
  return {
    ...actual,
    createBlockSplitter: () =>
      actual.createBlockSplitter((text) => {
        controls.split(text)
        return actual.completedBlocks(text)
      }),
  }
})

function mount(text: string, growing = false, literalHtml = false) {
  const view = render(<CompletedMarkdown {...{ text, growing, literalHtml }} />)
  const html = view.container.innerHTML
  view.unmount()
  return html
}

it.each([
  'Plain text.',
  '# Heading\n\n- one\n- two',
  '| A | B |\n|---|---|\n| 1 | 2 |',
  '```text\none\n```\n\n```text\ntwo\n```',
  'Use `code`, [a link](https://example.org) and ![image](https://example.org/a.png).',
  'Compute $x^2$.',
  '```text\nopen fence',
  'Sentence with **bold**. ' + 'long text '.repeat(6000),
  '[see][r]\r\n\r\n[r]: https://example.org',
  'Note[^a].\n\n[^a]: description',
  '<i>literal</i>',
])('preserves uncached HTML on first mount and remount %#', (text) => {
  controls.bypass = true
  const expected = mount(text, false, text.startsWith('<'))
  controls.bypass = false
  expect(mount(text, false, text.startsWith('<'))).toBe(expected)
  expect(mount(text, false, text.startsWith('<'))).toBe(expected)
})

it('splits each resident finished content once across remounts and isolates growing rows', () => {
  const text = '# Already closed\n\nThe open tail'
  controls.split.mockClear()
  const partial = mount(text, true)
  expect(partial).not.toContain('The open tail')
  controls.split.mockClear()
  for (let i = 0; i < 5; i++) expect(mount(text)).toContain('The open tail')
  expect(controls.split).toHaveBeenCalledTimes(1)
  expect(mount(text, true)).toBe(partial)
  expect(controls.split).toHaveBeenCalledTimes(2)
})

it('evicts least recently used entries by byte charge and skips oversized inputs', () => {
  const cache = createFinishedBlockCache(400)
  const split = vi.fn((s: string) => [s])
  for (const key of ['a', 'b', 'a', 'x'.repeat(200), 'c', 'a', 'b']) cache(key, split)
  expect(split.mock.calls.flat()).toEqual(['a', 'b', 'x'.repeat(200), 'c', 'b'])
})
