// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { preserveProjectFileLinks } from '../project-file-link.js'
import { CompletedMarkdown } from './CompletedMarkdown.js'
import { Markdown } from './Markdown.js'
import { createRevealClock, replaceRevealClock } from './reveal-clock.js'
import { fakeRevealEnvironment } from './reveal-clock.fixture.js'

/** The content of every finished-renderer block render, in order. */
const blockRenders = vi.hoisted((): string[] => [])

vi.mock('../project-file-link.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../project-file-link.js')>()
  return { ...actual, preserveProjectFileLinks: vi.fn(actual.preserveProjectFileLinks) }
})

vi.mock('./LargeCodeBlock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./LargeCodeBlock.js')>()
  const { createElement, memo } = await import('react')
  const CountedBlock = memo(function CountedBlock(
    props: Parameters<typeof actual.MarkdownBlock>[0],
  ) {
    blockRenders.push(props.content)
    return createElement(actual.MarkdownBlock, props)
  })
  return { ...actual, MarkdownBlock: CountedBlock }
})

const HEAD = '## Plan\n\nFirst we read the handler and the retry path.\n\n'
const CODE = '```ts\nconst ready = true\n```\n\n'
const TAIL = 'Then the `retry.ts` change, and the tests:\n\n- one\n- two'

let fake: ReturnType<typeof fakeRevealEnvironment>

beforeAll(async () => {
  // A first rich reply loads the finished renderer, as on a running app.
  render(<Markdown text="Load `the` renderer" streaming />)
  await act(async () => {
    await import('./CompletedMarkdown.js')
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  cleanup()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fake = fakeRevealEnvironment()
  replaceRevealClock(createRevealClock(fake.env))
  blockRenders.length = 0
})

afterEach(() => {
  cleanup()
  replaceRevealClock(undefined)
  vi.useRealTimers()
})

const catchUp = () => act(() => void vi.advanceTimersByTime(300))
const frames = (count: number) =>
  act(() => {
    for (let frame = 0; frame < count; frame += 1) fake.frame(16)
  })
const ahead = (container: HTMLElement) => container.querySelector<HTMLElement>('.md-ahead')
const live = (container: HTMLElement) => container.querySelector('[data-streaming-markdown]')

function stream(text: string) {
  const view = render(<Markdown text={text} streaming />)
  let version = 0
  let current = text
  return {
    ...view,
    append(delta: string) {
      current += delta
      version += 1
      view.rerender(
        <Markdown
          text={current}
          streaming
          liveUpdate={{ kind: 'append', text: delta }}
          updateVersion={version}
        />,
      )
    },
    finish() {
      view.rerender(<Markdown text={current} />)
    },
  }
}

describe('a streaming rich reply', () => {
  it('renders its closed blocks ahead, out of view', () => {
    const view = stream(HEAD)
    view.append('```ts\nconst rea')
    expect(ahead(view.container)).toBeNull()

    catchUp()

    const tree = ahead(view.container)!
    expect(tree).not.toBeNull()
    expect(tree.querySelector('h2')?.textContent).toBe('Plan')
    expect(tree.textContent).toContain('First we read the handler')
    // The open code block is the live renderer's alone until it closes.
    expect(tree.querySelector('pre')).toBeNull()
    expect(tree.textContent).not.toContain('const rea')
    expect(live(view.container)).not.toBeNull()
  })

  it('takes over by showing that tree, without rendering its blocks again', () => {
    const view = stream(HEAD)
    view.append(CODE)
    view.append(TAIL.slice(0, 20))
    catchUp()
    view.append(TAIL.slice(20))
    catchUp()
    const tree = ahead(view.container)!
    const heading = tree.querySelector('h2')
    const code = tree.querySelector('pre')
    expect(code?.textContent).toContain('const ready = true')
    blockRenders.length = 0

    view.finish()
    frames(60)

    expect(live(view.container)).toBeNull()
    expect(ahead(view.container)).toBeNull()
    const shown = view.container.querySelector<HTMLElement>('.md')!
    expect(shown).toBe(tree)
    expect(shown.querySelector('h2')).toBe(heading)
    expect(shown.querySelector('pre')).toBe(code)
    // Only the last block, open at the last catch-up, rendered at the end.
    expect(blockRenders).toEqual(['- one\n- two'])
  })

  it('ends with the same DOM as a reply rendered finished', () => {
    const view = stream(HEAD)
    view.append(CODE)
    catchUp()
    view.append(TAIL)
    view.finish()
    frames(60)
    const shown = view.container.querySelector<HTMLElement>('.md')!.outerHTML

    const cold = render(<CompletedMarkdown text={`${HEAD}${CODE}${TAIL}`} />)
    expect(shown).toBe(cold.container.querySelector('.md')!.outerHTML)
  })

  it('takes over with every block when it ends between catch-ups', () => {
    const view = stream(HEAD)
    catchUp()
    view.append(CODE)
    view.append(TAIL)
    // No catch-up since the code block and the list arrived.
    view.finish()
    frames(60)

    const shown = view.container.querySelector<HTMLElement>('.md')!
    expect(live(view.container)).toBeNull()
    expect(shown.querySelector('pre')?.textContent).toContain('const ready = true')
    expect(shown.querySelectorAll('li')).toHaveLength(2)
  })

  it('gives the tree ahead the last words in a background render, not in the ending commit', () => {
    const container = document.body.appendChild(document.createElement('div'))
    // The finished renderer prepares a new text's links first thing.
    const prepared = () => vi.mocked(preserveProjectFileLinks).mock.calls.length
    const commits: number[] = []
    const record = () => commits.push(prepared())
    const tree = (text: string, streaming: boolean, version?: number, delta?: string) => (
      <Profiler id="reply" onRender={record}>
        <Markdown
          text={text}
          streaming={streaming}
          {...(delta ? { liveUpdate: { kind: 'append' as const, text: delta } } : {})}
          updateVersion={version}
        />
      </Profiler>
    )
    const view = render(tree(HEAD + CODE, true), { container })
    catchUp()
    view.rerender(tree(HEAD + CODE + TAIL, true, 1, TAIL))
    commits.length = 0
    const before = prepared()

    view.rerender(tree(HEAD + CODE + TAIL, false))

    // Untouched in the commit that ends the reply; given the text after it.
    expect(commits[0]).toBe(before)
    expect(commits.at(-1)).toBeGreaterThan(before)
    expect(ahead(container)?.textContent).toContain('two')
  })

  it('takes over at once from the tree rendered ahead when motion is reduced', () => {
    fake.setMotion(false)
    const view = stream(HEAD)
    view.append(CODE)
    catchUp()
    const tree = ahead(view.container)!
    view.finish()

    expect(live(view.container)).toBeNull()
    expect(view.container.querySelector('.md')).toBe(tree)
    expect(tree.classList.contains('md-ahead')).toBe(false)
  })
})

describe('the finished renderer', () => {
  it('reports a text once the commit that shows all its blocks is done', () => {
    vi.useRealTimers()
    const seen: Array<[string, string]> = []
    const container = document.body.appendChild(document.createElement('div'))
    const onRendered = (text: string) => {
      seen.push([text, container.querySelector('.md')?.textContent ?? ''])
    }
    const first = `${HEAD}${CODE}`
    const view = render(<CompletedMarkdown text={first} hidden onRendered={onRendered} />, {
      container,
    })
    expect(seen.map(([text]) => text)).toEqual([first])

    const final = `${first}${TAIL}`
    view.rerender(<CompletedMarkdown text={final} hidden onRendered={onRendered} />)
    expect(seen.map(([text]) => text)).toEqual([first, final])
    // Streamdown shows a new text's blocks a commit after the text: the
    // report comes once the list is on screen.
    expect(seen[1]![1]).toContain('two')
  })

  it('does not report while the text still grows', () => {
    vi.useRealTimers()
    const onRendered = vi.fn()
    render(<CompletedMarkdown text={`${HEAD}${CODE}`} hidden growing onRendered={onRendered} />)
    expect(onRendered).not.toHaveBeenCalled()
  })
})

describe('a streaming plain reply', () => {
  it('renders nothing ahead', () => {
    const view = stream('Just a plain answer')
    view.append(' that keeps going for a while.')
    catchUp()
    expect(ahead(view.container)).toBeNull()
    view.finish()
    frames(60)
    expect(view.container.querySelector('[data-plain-markdown]')?.textContent).toBe(
      'Just a plain answer that keeps going for a while.',
    )
  })
})
