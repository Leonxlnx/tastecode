// Test support for the reveal clock: a fake environment the test drives frame by frame.
import { REVEAL_VEIL, type RevealEnvironment } from './reveal-clock.js'

/** A StaticRange stand-in: happy-dom has no Custom Highlight API. */
class FakeRange implements AbstractRange {
  readonly startContainer: Node
  readonly startOffset: number
  readonly endContainer: Node
  readonly endOffset: number
  readonly collapsed: boolean
  constructor(init: StaticRangeInit) {
    this.startContainer = init.startContainer
    this.startOffset = init.startOffset
    this.endContainer = init.endContainer
    this.endOffset = init.endOffset
    this.collapsed =
      init.startContainer === init.endContainer && init.startOffset === init.endOffset
  }
}

/** A clock environment driven by the test: its own frames, timers and highlight sets. */
export function fakeRevealEnvironment() {
  let time = 1000
  let frames = new Map<number, (now: number) => void>()
  let nextHandle = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const highlights = new Map<string, Set<AbstractRange>>()
  const listeners: Array<() => void> = []
  let motion = true
  let api = true
  const env: RevealEnvironment = {
    now: () => time,
    requestFrame(callback) {
      const handle = nextHandle++
      frames.set(handle, callback)
      return handle
    },
    cancelFrame: (handle) => void frames.delete(handle),
    setTimer(run, ms) {
      const handle = nextHandle++
      timers.set(handle, { at: time + ms, run })
      return handle
    },
    clearTimer: (handle) => void timers.delete(handle),
    highlight(name) {
      if (!api) return undefined
      let highlight = highlights.get(name)
      if (!highlight) highlights.set(name, (highlight = new Set()))
      return highlight
    },
    createRange: (init) => new FakeRange(init),
    motionAllowed: () => motion,
    onMotionChange: (listener) => void listeners.push(listener),
  }
  return {
    env,
    get time() {
      return time
    },
    /** Runs one display frame `dt` ms after the previous one. */
    frame(dt = 16) {
      time += dt
      const pending = frames
      frames = new Map()
      for (const callback of pending.values()) callback(time)
    },
    pendingFrames: () => frames.size,
    /** Passes time without frames, running due timers. */
    wait(ms: number) {
      time += ms
      for (const [handle, timer] of timers) {
        if (timer.at > time) continue
        timers.delete(handle)
        timer.run()
      }
    },
    setMotion(allowed: boolean) {
      motion = allowed
      for (const listener of listeners) listener()
    },
    removeApi() {
      api = false
    },
    ranges: (name = REVEAL_VEIL): AbstractRange[] => [...(highlights.get(name) ?? [])],
  }
}

/** The text before the veil's start: what the reader sees. */
export function visibleText(root: HTMLElement, ranges: readonly AbstractRange[]): string {
  const veil = ranges.find((range) => root.contains(range.startContainer))
  if (!veil) return root.textContent ?? ''
  if (veil.startContainer === root) return ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let shown = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data
    if (node === veil.startContainer) return shown + data.slice(0, veil.startOffset)
    shown += data
  }
  return shown
}
