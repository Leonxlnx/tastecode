// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Item } from '@harness/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, reduce, type ThreadState } from '../thread-store.js'
import { Thread } from './Thread.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 72 })),
    getTotalSize: () => count * 72,
    measureElement: () => undefined,
    indexFromElement: (node: Element) => Number(node.getAttribute('data-index')),
    resizeItem: () => undefined,
    measurementsCache: [],
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }),
}))

const stylesheet = document.createElement('style')
stylesheet.textContent = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../styles/markdown.css'),
  'utf8',
)
beforeAll(() => document.head.append(stylesheet))
afterAll(() => stylesheet.remove())
afterEach(cleanup)

function message(id: string, createdAt: number, fields: Partial<Item>): Item {
  return {
    id,
    turnId: 'turn-1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    createdAt,
    ...fields,
  }
}

function renderThread(state: ThreadState) {
  return render(
    <Thread
      frameStore={new ThreadFrameStore(state)}
      onDecide={() => undefined}
      onAnswerUserInput={() => undefined}
    />,
  )
}

async function completedReply(text: string): Promise<Element> {
  const { container } = renderThread({
    ...emptyThread,
    items: [message('answer', 1, { phase: 'final_answer', text })],
  })
  await waitFor(() =>
    expect(container.querySelector('.reply [data-streaming-markdown]')).toBeNull(),
  )
  return container.querySelector('.reply')!
}

function streamingReply(text: string): Element {
  let state = reduce(emptyThread, {
    type: 'turn.started',
    turn: { id: 'turn-1', threadId: 'thread-1', status: 'running', createdAt: 1 },
  })
  state = reduce(state, {
    type: 'item.started',
    item: message('answer', 2, { status: 'started', text }),
  })
  return renderThread(state).container.querySelector('.reply.is-streaming')!
}

function childNodes(element: Element): Array<string | null> {
  return [...element.childNodes].map((node) =>
    node.nodeType === Node.TEXT_NODE ? node.textContent : node.nodeName,
  )
}

describe('chat reply line breaks', () => {
  it('shows each line of a plain reply on its own line', async () => {
    const paragraph = (await completedReply('1\n2\n3')).querySelector('p')!

    expect(paragraph.textContent).toBe('1\n2\n3')
    expect(getComputedStyle(paragraph).whiteSpace).toBe('pre-line')
  })

  it('keeps a single line break in a rich reply', async () => {
    const reply = await completedReply('Use **bold**\nnext line')
    const paragraph = reply.querySelector('p')!

    expect(reply.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold')
    expect(paragraph.textContent).toBe('Use bold\nnext line')
    expect(getComputedStyle(paragraph).whiteSpace).toBe('pre-line')
  })

  it('keeps a single line break while the reply streams', () => {
    const reply = streamingReply('Use **bold**\nnext line')
    const paragraph = reply.querySelector('[data-streaming-markdown] p')!

    expect(paragraph.querySelector('strong')?.textContent).toBe('bold')
    expect(paragraph.textContent).toBe('Use bold\nnext line')
    expect(getComputedStyle(paragraph).whiteSpace).toBe('pre-line')
  })

  it('starts a plain reply on its first line', async () => {
    const paragraph = (await completedReply('\n1\n2\n')).querySelector('p')!

    expect(paragraph.textContent).toBe('1\n2')
  })

  it('shows a hard break once instead of as a blank line', async () => {
    const paragraph = (await completedReply('hard  \nbreak **x**')).querySelector('p')!

    expect(childNodes(paragraph)).toEqual(['hard', 'BR', 'break ', 'SPAN'])
  })

  it('adds no blank lines around a nested list', async () => {
    const reply = await completedReply('- **Install**\n  Run the installer.\n- Second\n  - nested')
    const [install, second, nested] = reply.querySelectorAll('li')

    expect(install!.textContent).toBe('Install\nRun the installer.')
    expect(getComputedStyle(install!).whiteSpace).toBe('pre-line')
    expect(childNodes(second!)).toEqual(['Second\n', 'UL'])
    expect(childNodes(nested!.parentElement!)).toEqual(['LI'])
  })

  it('adds no blank lines around the paragraphs of a loose list item', async () => {
    const reply = await completedReply('- loose a\n\n  para two\n\n- loose b')

    expect(childNodes(reply.querySelector('li')!)).toEqual(['P', 'P'])
  })

  it('keeps quoted lines apart without blank lines around them', async () => {
    const quote = (await completedReply('> quote line\n> second **q**')).querySelector(
      'blockquote',
    )!

    expect(childNodes(quote)).toEqual(['P'])
    expect(quote.querySelector('p')!.textContent).toBe('quote line\nsecond q')
  })

  it('joins a line break inside inline code as the completed reply does', async () => {
    const live = streamingReply('use `foo\nbar` and **x**').querySelector('code')!
    expect(live.textContent).toBe('foo\nbar')
    expect(getComputedStyle(live).whiteSpace).not.toBe('pre-line')
    cleanup()

    const completed = (await completedReply('use `foo\nbar` and **x**')).querySelector('code')!
    expect(completed.textContent).toBe('foo bar')
  })

  it('keeps line breaks in a reply folded into the work summary', () => {
    renderThread({
      ...emptyThread,
      items: [
        message('prompt', 1, { role: 'user', text: 'Check this' }),
        message('intro', 2, { phase: 'commentary', text: 'Checking files.\nThen tests.' }),
        message('cmd', 3, { type: 'command', command: 'ls', text: 'output' }),
        message('answer', 4, { phase: 'final_answer', text: 'Done.' }),
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    const paragraph = document.querySelector('.activity__message p')!

    expect(paragraph.textContent).toBe('Checking files.\nThen tests.')
    expect(getComputedStyle(paragraph).whiteSpace).toBe('pre-line')
  })
})
