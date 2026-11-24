// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@harness/contracts'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, type ThreadState } from '../thread-store.js'
import { Thread } from './Thread.js'

const VIEWPORT = 800
const ROW_HEIGHT = 40

/**
 * `real` is the list Thread uses. `every` hands Thread every row without sizes,
 * as a list that has measured nothing yet would: the transcript as it rendered
 * before hidden work rows were left out.
 */
const mode = vi.hoisted(() => ({ list: 'real' as 'real' | 'every' }))
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return {
    ...original,
    useVirtualizer: ((options: Parameters<typeof original.useVirtualizer>[0]) => {
      const list = original.useVirtualizer(options)
      if (mode.list === 'real') return list
      return {
        ...list,
        getVirtualItems: () =>
          Array.from({ length: options.count }, (_, index) => ({
            index,
            key: options.getItemKey?.(index) ?? index,
            start: index * ROW_HEIGHT,
            end: (index + 1) * ROW_HEIGHT,
            size: ROW_HEIGHT,
            lane: 0,
          })),
        measurementsCache: [],
      }
    }) as typeof original.useVirtualizer,
  }
})

beforeEach(() => {
  mode.list = 'real'
  // Hidden rows measure 0, every other row one line.
  const heightOf = (element: HTMLElement) => {
    if (element.classList.contains('thread')) return VIEWPORT
    if (element.classList.contains('thread__row'))
      return element.classList.contains('is-suppressed') ? 0 : ROW_HEIGHT
    return 0
  }
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return heightOf(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = heightOf(this)
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 720,
      bottom: height,
      width: 720,
      height,
      toJSON() {},
    } as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return heightOf(this)
  })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** One finished turn: a prompt, `work` tool rows of every kind, and the answer. */
function turn(turnId: string, createdAt: number, work: number, prefix = ''): Item[] {
  const kinds: Array<Partial<Item>> = [
    { type: 'command', command: 'git status', text: 'On branch dev\n', exitCode: 0 },
    { type: 'tool_call', text: 'Read {"file_path":"README.md"}' },
    { type: 'reasoning', text: 'Checking the tests' },
    { type: 'file_change', path: 'src/a.ts', linesAdded: 2, linesRemoved: 1 },
  ]
  return [
    {
      id: `${prefix}${turnId}-prompt`,
      turnId,
      type: 'message',
      role: 'user',
      status: 'completed',
      text: `Prompt of ${turnId}`,
      createdAt,
    },
    ...Array.from({ length: work }, (_, index): Item => ({
      id: `${prefix}${turnId}-work-${index}`,
      turnId,
      status: 'completed',
      createdAt: createdAt + 1 + index,
      ...(kinds[index % kinds.length] as Pick<Item, 'type'>),
    })),
    {
      id: `${prefix}${turnId}-answer`,
      turnId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text: `Answer of ${turnId}`,
      createdAt: createdAt + 1 + work,
    },
  ]
}

/** An imported turn, a native one with a long disclosure, and a short last turn. */
function history(): ThreadState {
  const items = [
    ...turn('import:old', 0, 6, 'import:'),
    ...turn('turn-1', 100, 240),
    ...turn('turn-2', 1_000, 3),
  ]
  const turnTiming = Object.fromEntries(
    ['import:old', 'turn-1', 'turn-2'].map((id) => [id, { startedAt: 0, completedAt: 1 }]),
  )
  return { ...emptyThread, items, turnTiming } as ThreadState
}

function open(state: ThreadState) {
  const store = new ThreadFrameStore(state)
  const view = render(
    <Thread frameStore={store} onDecide={() => undefined} onAnswerUserInput={() => undefined} />,
  )
  return { store, view }
}

/** What a reader can see of each row: everything but the list's own positioning. */
function shownRows(container: HTMLElement): Map<string, string> {
  const shown = new Map<string, string>()
  for (const row of container.querySelectorAll<HTMLElement>('.thread__row')) {
    const copy = row.cloneNode(true) as HTMLElement
    copy.removeAttribute('style')
    if (row.classList.contains('is-suppressed')) {
      // A hidden row is a zero-height box with nothing inside.
      expect(copy.innerHTML).toBe('')
      continue
    }
    shown.set(row.getAttribute('data-index')!, copy.outerHTML)
  }
  return shown
}

describe('rows hidden inside a finished work disclosure', () => {
  it('are left out of the transcript, which shows the same rows as when every row mounted', async () => {
    mode.list = 'every'
    const before = open(history())
    const everyRow = shownRows(before.view.container)
    const mountedBefore = before.view.container.querySelectorAll('.thread__row').length
    cleanup()

    mode.list = 'real'
    const after = open(history())
    await act(async () => {
      await Promise.resolve()
    })
    const mounted = after.view.container.querySelectorAll('.thread__row')
    const shown = shownRows(after.view.container)

    // The whole chat fits the viewport, so both renders cover every row.
    expect(mountedBefore).toBe(history().items.length)
    expect([...shown.keys()]).toEqual([...everyRow.keys()])
    for (const [index, html] of shown) expect(html).toBe(everyRow.get(index))
    // Only the rows a reader sees mount: prompts, disclosure leads, answers.
    expect(mounted.length).toBe(shown.size)
    expect(mounted.length).toBeLessThan(20)
  })

  it('mount while their turn runs and are left out once it finished', async () => {
    const state = history()
    const running: ThreadState = {
      ...state,
      running: true,
      activeTurn: { id: 'turn-2', startedAt: 1_000 },
    } as ThreadState
    const { store, view } = open(running)
    await act(async () => {
      await Promise.resolve()
    })
    const row = (index: number) =>
      view.container.querySelector<HTMLElement>(`.thread__row[data-index="${index}"]`)
    // turn-2's tool rows follow the import (8 rows) and turn-1 (242 rows).
    const firstWork = 8 + 242 + 1
    // Hidden already, but a running turn's rows mount as before.
    expect(row(firstWork + 1)?.classList.contains('is-suppressed')).toBe(true)
    // turn-1's hidden rows never mount.
    expect(row(8 + 2)).toBeNull()

    await act(async () => {
      store.publish(state)
      await Promise.resolve()
    })
    // Finished, they show nothing and the list takes them as 0: left out.
    expect(row(firstWork + 1)).toBeNull()
    expect(row(8 + 2)).toBeNull()
  })
})
