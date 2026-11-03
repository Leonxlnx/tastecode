import { useEffect, useRef, useState, type RefObject } from 'react'
import type { PaneSlot } from '../thread-controller.js'
import { loadSplitViewStyles } from './split-view-context.js'
import type { RowDropTarget } from './useRowDrag.js'

/**
 * Dropping a chat dragged from the sidebar onto the chat area. Without a split,
 * the right half opens the chat beside the current one and the rest replaces
 * the current chat. With a split, a pane takes the chat: a new chat replaces
 * that pane's chat, and a chat already shown in the other pane swaps sides.
 */

export type Box = { left: number; top: number; right: number; bottom: number }

/** Where in the chat area a dragged chat would land. */
export type ChatDropZone =
  /** Without a split, the right half: the chat opens beside the current one. */
  | { kind: 'beside' }
  /** A pane: the dropped chat replaces the one it shows. */
  | { kind: 'pane'; slot: PaneSlot }

/** The chat area as it is laid out now. */
export type ChatDropLayout =
  | { split: false; slot: PaneSlot; area: Box }
  | { split: true; panes: ReadonlyArray<{ slot: PaneSlot; box: Box }> }

export type ChatDropHit = { zone: ChatDropZone; box: Box }

function inside(box: Box, x: number, y: number): boolean {
  return x >= box.left && x < box.right && y >= box.top && y < box.bottom
}

/** The zone under the pointer, and the box to highlight for it. */
export function chatDropZoneAt(
  x: number,
  y: number,
  layout: ChatDropLayout,
): ChatDropHit | undefined {
  if (layout.split) {
    const pane = layout.panes.find(({ box }) => inside(box, x, y))
    return pane ? { zone: { kind: 'pane', slot: pane.slot }, box: pane.box } : undefined
  }
  const { area } = layout
  if (!inside(area, x, y)) return undefined
  const middle = (area.left + area.right) / 2
  return x >= middle
    ? { zone: { kind: 'beside' }, box: { ...area, left: middle } }
    : { zone: { kind: 'pane', slot: layout.slot }, box: area }
}

/** What split view shows when a chat is dropped. */
export type ChatDropState = {
  split: boolean
  focusedSlot: PaneSlot
  /** The focused pane's chat. */
  activeId: string | undefined
  /** The other pane's chat. */
  besideId: string | undefined
}

/** What a drop does. Each one ends with the dropped chat in the focused pane. */
export type ChatDropAction =
  /** Show it in the focused pane, as a click on its row does. */
  | { kind: 'open' }
  /** Show it in the other pane, opening one if there is none; that pane takes focus. */
  | { kind: 'beside' }
  /** The two panes trade sides; with focusOther, focus moves to the other pane as well. */
  | { kind: 'swap'; focusOther: boolean }

/** Undefined when the drop would change nothing, so no zone lights up for it. */
export function planChatDrop(
  id: string,
  zone: ChatDropZone,
  state: ChatDropState,
): ChatDropAction | undefined {
  if (zone.kind === 'beside') {
    return state.split || id === state.activeId ? undefined : { kind: 'beside' }
  }
  if (!state.split) return id === state.activeId ? undefined : { kind: 'open' }
  const onFocused = zone.slot === state.focusedSlot
  if (id === state.activeId) return onFocused ? undefined : { kind: 'swap', focusOther: false }
  if (id === state.besideId) return onFocused ? { kind: 'swap', focusOther: true } : undefined
  return onFocused ? { kind: 'open' } : { kind: 'beside' }
}

/**
 * Reads the chat area inside the stage body. A split's panes carry their slot;
 * a single chat fills the body above the bottom terminal.
 */
export function readChatDropLayout(
  host: HTMLElement,
  focusedSlot: PaneSlot,
): ChatDropLayout | undefined {
  const panes = host.querySelectorAll<HTMLElement>('.split__pane[data-split-slot]')
  if (panes.length > 0) {
    return {
      split: true,
      panes: Array.from(panes, (pane) => ({
        slot: pane.dataset['splitSlot'] === '1' ? 1 : 0,
        box: pane.getBoundingClientRect(),
      })),
    }
  }
  const area = host.getBoundingClientRect()
  const terminal = host.querySelector('.bottom-terminal.is-open')
  const bottom = terminal
    ? Math.min(area.bottom, terminal.getBoundingClientRect().top)
    : area.bottom
  if (area.right <= area.left || bottom <= area.top) return undefined
  return {
    split: false,
    slot: focusedSlot,
    area: { left: area.left, top: area.top, right: area.right, bottom },
  }
}

/** The highlighted zone, placed in the stage body's own coordinates. */
export type ChatDropHover = {
  zone: ChatDropZone
  left: number
  top: number
  width: number
  height: number
}

export type ChatDropStore = {
  get: () => ChatDropHover | undefined
  subscribe: (listener: () => void) => () => void
}

export type ChatDropOptions = {
  /** The stage body: the panes are inside it and the highlight is drawn in it. */
  host: () => HTMLElement | null | undefined
  state: () => ChatDropState
  apply: (id: string, action: ChatDropAction) => void
}

const sameHover = (a: ChatDropHover | undefined, b: ChatDropHover | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.zone.kind === b.zone.kind &&
    (a.zone.kind === 'beside' || (b.zone.kind === 'pane' && a.zone.slot === b.zone.slot)) &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height)

/** A drop target for sidebar rows, and the store the highlight reads. */
export type ChatDrop = {
  store: ChatDropStore
  target: RowDropTarget
  /** Stops listening for a release that never reached the row. */
  dispose: () => void
}

export function createChatDrop(options: RefObject<ChatDropOptions>): ChatDrop {
  let hover: ChatDropHover | undefined
  const listeners = new Set<() => void>()
  const show = (next: ChatDropHover | undefined) => {
    if (sameHover(hover, next)) return
    hover = next
    for (const listener of listeners) listener()
  }
  // The release normally reaches drop() or leave(). If the held row left the
  // page mid-drag, its release lands elsewhere; this still clears the highlight.
  let watching = false
  const clear = () => {
    if (!watching) return
    watching = false
    window.removeEventListener('pointerup', clear, true)
    window.removeEventListener('pointercancel', clear, true)
    window.removeEventListener('blur', clear)
    show(undefined)
  }
  const watch = () => {
    if (watching) return
    watching = true
    window.addEventListener('pointerup', clear, true)
    window.addEventListener('pointercancel', clear, true)
    window.addEventListener('blur', clear)
  }
  const resolve = (id: string, x: number, y: number) => {
    const host = options.current.host()
    if (!host || host.hidden) return undefined
    const state = options.current.state()
    const layout = readChatDropLayout(host, state.focusedSlot)
    if (!layout || layout.split !== state.split) return undefined
    const hit = chatDropZoneAt(x, y, layout)
    const action = hit && planChatDrop(id, hit.zone, state)
    if (!hit || !action) return undefined
    const origin = host.getBoundingClientRect()
    const hover: ChatDropHover = {
      zone: hit.zone,
      left: hit.box.left - origin.left,
      top: hit.box.top - origin.top,
      width: hit.box.right - hit.box.left,
      height: hit.box.bottom - hit.box.top,
    }
    return { action, hover }
  }
  return {
    store: {
      get: () => hover,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    target: {
      move: (id, x, y) => {
        const next = resolve(id, x, y)?.hover
        if (next && !hover) {
          // The highlight's styles ship with split view's, which load on first use.
          void loadSplitViewStyles().catch(() => undefined)
          watch()
        }
        show(next)
      },
      drop: (id, x, y) => {
        const resolved = resolve(id, x, y)
        clear()
        show(undefined)
        if (resolved) options.current.apply(id, resolved.action)
      },
      leave: () => {
        clear()
        show(undefined)
      },
    },
    dispose: clear,
  }
}

/**
 * The drop target for sidebar rows and the store its highlight reads. Both keep
 * one identity for the component's life, and pointer movement only reaches the
 * store's subscriber, never the component that owns it.
 */
export function useChatDrop(options: ChatDropOptions): ChatDrop {
  const latest = useRef(options)
  latest.current = options
  const [drop] = useState(() => createChatDrop(latest))
  useEffect(() => drop.dispose, [drop])
  return drop
}
