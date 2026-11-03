// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chatDropZoneAt,
  createChatDrop,
  planChatDrop,
  readChatDropLayout,
  type ChatDropLayout,
  type ChatDropOptions,
  type ChatDropState,
} from './chat-drop.js'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const box = (left: number, right: number, top = 0, bottom = 800) => ({ left, right, top, bottom })
const single: ChatDropLayout = { split: false, slot: 0, area: box(0, 1000) }
// The second pane opened (slot 1) may sit on the left.
const split: ChatDropLayout = {
  split: true,
  panes: [
    { slot: 1, box: box(0, 500) },
    { slot: 0, box: box(500, 1000) },
  ],
}

const alone: ChatDropState = { split: false, focusedSlot: 0, activeId: 'a', besideId: undefined }
const both: ChatDropState = { split: true, focusedSlot: 0, activeId: 'a', besideId: 'b' }

function placeAt(element: Element, left: number, top: number, right: number, bottom: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  })
}

describe('chatDropZoneAt', () => {
  it('opens beside on the right half of a single chat and replaces the chat elsewhere', () => {
    expect(chatDropZoneAt(800, 400, single)).toEqual({
      zone: { kind: 'beside' },
      box: box(500, 1000),
    })
    expect(chatDropZoneAt(500, 400, single)?.zone).toEqual({ kind: 'beside' })
    expect(chatDropZoneAt(499, 400, single)).toEqual({
      zone: { kind: 'pane', slot: 0 },
      box: box(0, 1000),
    })
  })

  it('takes the pane under the pointer in a split, whichever side it sits on', () => {
    expect(chatDropZoneAt(100, 400, split)).toEqual({
      zone: { kind: 'pane', slot: 1 },
      box: box(0, 500),
    })
    expect(chatDropZoneAt(900, 400, split)?.zone).toEqual({ kind: 'pane', slot: 0 })
  })

  it('finds nothing outside the chat area', () => {
    expect(chatDropZoneAt(-1, 400, single)).toBeUndefined()
    expect(chatDropZoneAt(1000, 400, single)).toBeUndefined()
    expect(chatDropZoneAt(300, 800, split)).toBeUndefined()
  })
})

describe('planChatDrop', () => {
  it('opens another chat beside the current one, or in its place', () => {
    expect(planChatDrop('c', { kind: 'beside' }, alone)).toEqual({ kind: 'beside' })
    expect(planChatDrop('c', { kind: 'pane', slot: 0 }, alone)).toEqual({ kind: 'open' })
  })

  it('does nothing with the chat that is already open', () => {
    expect(planChatDrop('a', { kind: 'beside' }, alone)).toBeUndefined()
    expect(planChatDrop('a', { kind: 'pane', slot: 0 }, alone)).toBeUndefined()
  })

  it('replaces the chat of the pane it is dropped on', () => {
    expect(planChatDrop('c', { kind: 'pane', slot: 0 }, both)).toEqual({ kind: 'open' })
    expect(planChatDrop('c', { kind: 'pane', slot: 1 }, both)).toEqual({ kind: 'beside' })
  })

  it('moves a chat on screen to the other pane by swapping the two', () => {
    expect(planChatDrop('a', { kind: 'pane', slot: 1 }, both)).toEqual({
      kind: 'swap',
      focusOther: false,
    })
    expect(planChatDrop('b', { kind: 'pane', slot: 0 }, both)).toEqual({
      kind: 'swap',
      focusOther: true,
    })
    // Dropped where it already is.
    expect(planChatDrop('a', { kind: 'pane', slot: 0 }, both)).toBeUndefined()
    expect(planChatDrop('b', { kind: 'pane', slot: 1 }, both)).toBeUndefined()
  })

  it('fills a pane that holds a new chat like any other', () => {
    const fresh: ChatDropState = {
      split: true,
      focusedSlot: 1,
      activeId: undefined,
      besideId: undefined,
    }
    expect(planChatDrop('c', { kind: 'pane', slot: 1 }, fresh)).toEqual({ kind: 'open' })
    expect(planChatDrop('c', { kind: 'pane', slot: 0 }, fresh)).toEqual({ kind: 'beside' })
  })

  it('has no half-pane zone once a split is open', () => {
    expect(planChatDrop('c', { kind: 'beside' }, both)).toBeUndefined()
  })
})

function stageBody(options: { split?: boolean; terminal?: boolean } = {}) {
  const host = document.createElement('div')
  host.className = 'stage__body'
  const wrapper = host.appendChild(document.createElement('div'))
  wrapper.className = 'split'
  if (options.split) {
    for (const [slot, left, right] of [
      ['1', 100, 600],
      ['0', 600, 1100],
    ] as const) {
      const pane = wrapper.appendChild(document.createElement('section'))
      pane.className = 'split__pane'
      pane.dataset.splitSlot = slot
      placeAt(pane, left, 50, right, 650)
    }
  }
  if (options.terminal) {
    const terminal = host.appendChild(document.createElement('div'))
    terminal.className = 'bottom-terminal is-open'
    placeAt(terminal, 100, 650, 1100, 850)
  }
  placeAt(host, 100, 50, 1100, 850)
  document.body.append(host)
  return host
}

describe('readChatDropLayout', () => {
  it('reads both panes of a split by their slot', () => {
    expect(readChatDropLayout(stageBody({ split: true, terminal: true }), 0)).toEqual({
      split: true,
      panes: [
        { slot: 1, box: expect.objectContaining(box(100, 600, 50, 650)) },
        { slot: 0, box: expect.objectContaining(box(600, 1100, 50, 650)) },
      ],
    })
  })

  it('reads a single chat as the stage body above an open bottom terminal', () => {
    expect(readChatDropLayout(stageBody({ terminal: true }), 1)).toEqual({
      split: false,
      slot: 1,
      area: box(100, 1100, 50, 650),
    })
    expect(readChatDropLayout(stageBody(), 0)).toEqual({
      split: false,
      slot: 0,
      area: box(100, 1100, 50, 850),
    })
  })
})

describe('createChatDrop', () => {
  function setUp(host: HTMLElement, state: ChatDropState = alone) {
    const apply = vi.fn()
    const drop = createChatDrop({
      current: { host: () => host, state: () => state, apply } satisfies ChatDropOptions,
    })
    const changes = vi.fn()
    drop.store.subscribe(changes)
    return { ...drop, apply, changes }
  }

  it('highlights the zone under the pointer in the stage body’s coordinates', () => {
    const { store, target, changes } = setUp(stageBody())
    target.move('c', 900, 300)
    expect(store.get()).toEqual({
      zone: { kind: 'beside' },
      left: 500,
      top: 0,
      width: 500,
      height: 800,
    })
    // Moving inside the same zone tells no one.
    target.move('c', 950, 320)
    expect(changes).toHaveBeenCalledOnce()
    target.move('c', 300, 300)
    expect(store.get()).toEqual({
      zone: { kind: 'pane', slot: 0 },
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
    })
    // A drop that changes nothing lights nothing up.
    target.move('a', 300, 300)
    expect(store.get()).toBeUndefined()
  })

  it('applies a drop, then clears the highlight', () => {
    const { store, target, apply } = setUp(stageBody({ split: true }), both)
    target.move('c', 200, 300)
    expect(store.get()?.zone).toEqual({ kind: 'pane', slot: 1 })
    target.drop('c', 200, 300)
    expect(apply).toHaveBeenCalledExactlyOnceWith('c', { kind: 'beside' })
    expect(store.get()).toBeUndefined()
    target.drop('b', 900, 300)
    expect(apply).toHaveBeenLastCalledWith('b', { kind: 'swap', focusOther: true })
    // Released outside the chat area: nothing happens.
    apply.mockClear()
    target.drop('c', 50, 300)
    expect(apply).not.toHaveBeenCalled()
  })

  it('clears the highlight when the row comes back, and on a release that never reached it', () => {
    const { store, target } = setUp(stageBody())
    target.move('c', 900, 300)
    target.leave()
    expect(store.get()).toBeUndefined()
    target.move('c', 900, 300)
    expect(store.get()).toBeDefined()
    window.dispatchEvent(new Event('pointerup'))
    expect(store.get()).toBeUndefined()
  })

  it('finds nothing to drop on while the stage body is hidden', () => {
    const host = stageBody()
    host.hidden = true
    const { store, target, apply } = setUp(host)
    target.move('c', 900, 300)
    target.drop('c', 900, 300)
    expect(store.get()).toBeUndefined()
    expect(apply).not.toHaveBeenCalled()
  })
})
