// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'

// The rich renderer chunk loads only when the test releases it.
const chunk = vi.hoisted(() => ({ ready: Promise.resolve(), release: () => {} }))

vi.mock('./CompletedMarkdown.js', async () => {
  await chunk.ready
  return {
    CompletedMarkdown: ({ text }: { text: string }) => <div data-completed-markdown>{text}</div>,
  }
})

const RICH = [
  '## Rollout',
  '',
  '| Step | Owner |',
  '| --- | --- |',
  '| Ship | Web |',
  '',
  '```ts',
  'const ready = true',
  '```',
].join('\n')

async function freshMarkdown() {
  return (await import('./Markdown.js')).Markdown
}

beforeEach(() => {
  // Each test starts with the chunk not loaded yet, as on a new launch.
  vi.resetModules()
  chunk.ready = new Promise<void>((resolve) => {
    chunk.release = resolve
  })
})

afterEach(() => {
  cleanup()
})

describe('a rich reply completing', () => {
  it('keeps the live DOM while the rich renderer is still loading', async () => {
    const Markdown = await freshMarkdown()
    const view = render(<Markdown text={RICH} streaming />)
    const live = view.container.querySelector('[data-streaming-markdown]')
    expect(live?.querySelector('h2')?.textContent).toBe('Rollout')

    view.rerender(<Markdown text={RICH} />)

    // No collapse to plain paragraphs: the same live element stays mounted.
    expect(view.container.querySelector('[data-plain-markdown]')).toBeNull()
    expect(view.container.querySelector('[data-streaming-markdown]')).toBe(live)
    expect(live?.querySelector('h2')?.textContent).toBe('Rollout')
    expect(live?.getAttribute('aria-busy')).toBe('false')

    await act(async () => {
      chunk.release()
      await chunk.ready
    })
    await waitFor(() =>
      expect(view.container.querySelector('[data-completed-markdown]')?.textContent).toBe(RICH),
    )
    expect(view.container.querySelector('[data-streaming-markdown]')).toBeNull()
  })

  it('renders the rich renderer in the completing commit once it has preloaded', async () => {
    const Markdown = await freshMarkdown()
    // Streaming rich text starts the preload.
    const view = render(<Markdown text={RICH} streaming />)
    await act(async () => {
      chunk.release()
      await import('./CompletedMarkdown.js')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    view.rerender(<Markdown text={RICH} />)

    // Synchronously after the rerender: no Suspense fallback held in between.
    expect(view.container.querySelector('[data-completed-markdown]')?.textContent).toBe(RICH)
    expect(view.container.querySelector('[data-plain-markdown]')).toBeNull()
    expect(view.container.querySelector('[data-streaming-markdown]')).toBeNull()
  })
})
