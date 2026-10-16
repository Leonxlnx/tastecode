/**
 * The reveal clock: streamed text is laid out as soon as it arrives and shown
 * a little later, one character at a time.
 *
 * Providers deliver text in bursts: several words, then nothing for 50-150 ms.
 * Appending each burst as it lands makes a reply grow in jerks; stepping it
 * out a word at a time made it grow in word-sized hops, and a partial word
 * appended at a line end jumped to the next line once the rest arrived. Here
 * the page always holds everything that has arrived, so line breaks are final
 * the moment text lands, and a CSS Custom Highlight (`md-veil`) paints the
 * part the reader has not been shown yet in transparent ink. Every frame the
 * clock moves the veil's start forward by a fractional number of characters.
 * The speed follows how fast text arrives and how much is waiting, so the
 * edge moves on every frame at an even pace, 70-180 ms behind the provider.
 *
 * Per frame and live message: a few multiplications, a TreeWalker step over a
 * handful of characters and one StaticRange. No DOM mutation, no layout read.
 */

/** The veil aims to trail arrival by at least this much, so a burst never shows at once. */
const LAG_MIN_MS = 100
/** And by at most about this much: Leon's cap on how late text may appear. */
const LAG_MAX_MS = 180
/** Text that is due is reached within this. */
const CATCH_UP_MS = 40
/** How quickly the arrival-rate estimate follows the provider. */
const ARRIVAL_TAU_MS = 350
/** Longer silences count as a pause, not as a slow provider. */
const ARRIVAL_SPAN_MAX_MS = 120
/** chars/ms; a pasted log must not convince the clock that every later word is a flood. */
const ARRIVAL_RATE_MAX = 2
const INITIAL_ARRIVAL_RATE = 0.25
/** How long a long gap between arrivals keeps the lag wide. */
const GAP_DECAY_MS = 1200
/**
 * How hard the reveal speed leans on a backlog above or below its target.
 * At 1 the speed falls in proportion as the backlog runs low, down to
 * BACKLOG_FLOOR of the arrival rate, so the edge slows instead of running
 * dry between bursts.
 */
const BACKLOG_GAIN = 1
const BACKLOG_FLOOR = 0.1
/**
 * How quickly the reveal speed follows its target; it never changes in a
 * step. It speeds up faster than it slows down, so a backlog building up is
 * met before the lag cap has to force it.
 */
const REVEAL_UP_TAU_MS = 70
const REVEAL_DOWN_TAU_MS = 140
/** After this much silence beyond the lag the provider has paused: the rest drains. */
const QUIET_MS = 120
const DRAIN_MS = 150
/** chars/ms; nothing that is waiting crawls slower than this. */
const FLOOR_RATE = 0.04
/** A backlog beyond both of these is not reading material; it jumps close to the end. */
const SNAP_MIN_CHARS = 4000
const SNAP_MS = 1500
/** The longest frame step integrated at once, so a stalled frame does not leap. */
const MAX_FRAME_MS = 50
/** Assumed length of the first frame after the clock wakes. */
const FIRST_FRAME_MS = 16
/** A finished reply drains on frames; without frames (a hidden window) it shows at once. */
const FINISH_FALLBACK_MS = 1000

export const REVEAL_VEIL = 'md-veil'

/** Text inside these is chrome, not reply text: the reveal steps over it. */
const LABEL_SELECTOR = "[data-streamdown='code-block-header']"

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * How many characters of a growing text are shown at a given moment. Pure
 * bookkeeping; the cursor below maps the count onto the DOM.
 */
class RevealPace {
  /** Characters that have arrived. */
  total = 0
  /** Characters shown, fractional. */
  shown = 0
  private revealRate = 0
  private arrivalRate = INITIAL_ARRIVAL_RATE
  private gapPeak = 0
  private lastGrowth: number | undefined
  private lastActivity = -Infinity
  /** [time, total] at each growth not shown yet, oldest first. */
  private arrivals: Array<[number, number]> = []

  /**
   * `characters` arrived at `at`. Zero still counts as provider activity: the
   * parser is holding back markup (a table row until its line ends), so more
   * text is on its way and the backlog should not be drained as if it had
   * paused.
   */
  arrive(characters: number, at: number): void {
    this.lastActivity = at
    if (characters <= 0) return
    const gap = this.lastGrowth === undefined ? FIRST_FRAME_MS : Math.max(at - this.lastGrowth, 8)
    const span = Math.min(gap, ARRIVAL_SPAN_MAX_MS)
    const instant = Math.min(characters / span, ARRIVAL_RATE_MAX)
    this.arrivalRate += (instant - this.arrivalRate) * (1 - Math.exp(-span / ARRIVAL_TAU_MS))
    this.gapPeak = Math.max(Math.min(gap, LAG_MAX_MS), this.gapPeak * Math.exp(-gap / GAP_DECAY_MS))
    this.lastGrowth = at
    this.total += characters
    this.arrivals.push([at, this.total])
  }

  /** Counts `total` characters, all of them shown. */
  settle(total: number): void {
    this.total = total
    this.shown = total
    this.arrivals.length = 0
  }

  /** One frame of `dt` ms ending at `now`. */
  step(now: number, dt: number, finishing: boolean): number {
    const backlog = this.total - this.shown
    const lag = clamp(1.3 * this.gapPeak, LAG_MIN_MS, LAG_MAX_MS)
    const target = Math.max(4, this.arrivalRate * lag)
    let desired =
      this.arrivalRate * clamp(1 + (BACKLOG_GAIN * (backlog - target)) / target, BACKLOG_FLOOR, 4)
    if (finishing || now - this.lastActivity > lag + QUIET_MS) {
      desired = Math.max(desired, backlog / DRAIN_MS)
    }
    if (backlog > 0) desired = Math.max(desired, FLOOR_RATE)
    const tau = desired > this.revealRate ? REVEAL_UP_TAU_MS : REVEAL_DOWN_TAU_MS
    this.revealRate += (desired - this.revealRate) * (1 - Math.exp(-dt / tau))
    // Each arrival is due LAG_MAX_MS after it landed. The speed is never
    // below what meets the closest deadline: an isolated burst then shows at
    // an even pace that ends on time, instead of easing in and being forced
    // through at the end. Past due, the rest comes within CATCH_UP_MS.
    const arrivals = this.arrivals
    let passed = 0
    while (passed < arrivals.length && arrivals[passed]![1] <= this.shown) passed += 1
    if (passed > 0) arrivals.splice(0, passed)
    for (const [at, total] of arrivals) {
      const left = Math.max(at + LAG_MAX_MS - now, CATCH_UP_MS)
      this.revealRate = Math.max(this.revealRate, (total - this.shown) / left)
    }
    if (backlog > Math.max(SNAP_MIN_CHARS, this.arrivalRate * SNAP_MS)) {
      this.shown = this.total - this.arrivalRate * LAG_MAX_MS
    }
    this.shown = Math.min(this.total, this.shown + this.revealRate * dt)
    return this.shown
  }
}

/** The part of the Custom Highlight API the clock uses. */
export interface RevealHighlight {
  add(range: AbstractRange): unknown
  delete(range: AbstractRange): unknown
}

/** Everything the clock touches outside the DOM tree it reveals; tests drive a fake one. */
export interface RevealEnvironment {
  now(): number
  requestFrame(callback: (now: number) => void): number
  cancelFrame(handle: number): void
  setTimer(callback: () => void, ms: number): number
  clearTimer(handle: number): void
  /** The registered highlight of that name, or undefined where the API is missing. */
  highlight(name: string): RevealHighlight | undefined
  createRange(init: StaticRangeInit): AbstractRange
  /** False under prefers-reduced-motion and in a hidden document. */
  motionAllowed(): boolean
  /** Calls `listener` whenever motionAllowed() may have changed. */
  onMotionChange(listener: () => void): void
}

export interface RevealOptions {
  /** Called once, after finish(), when everything is shown. */
  onDrained?: () => void
}

export interface RevealCursor {
  /**
   * `characters` more text was appended at the end of the root. Called after
   * every live update, with 0 when the provider only sent held-back markup.
   */
  appended(characters: number): void
  /** Shows everything the root holds now, at once (an initial or replaced document). */
  reset(): void
  /** No more text will arrive: the rest drains quickly, then onDrained is called once. */
  finish(): void
  dispose(): void
  /**
   * True while the root's text nodes must stay where they are: the cursor
   * holds a position inside them. False where nothing is ever veiled.
   */
  readonly tracking: boolean
}

export interface RevealClock {
  attach(root: HTMLElement, options?: RevealOptions): RevealCursor
  /** Whether a live reply is revealed at all right now (API present, motion allowed). */
  enabled(): boolean
}

const SKIP_LABELS: NodeFilter = {
  acceptNode: (node) =>
    node.parentElement?.closest(LABEL_SELECTOR)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

interface ClockInternals {
  env: RevealEnvironment
  veil: RevealHighlight
  wake(cursor: Cursor): void
  forget(cursor: Cursor): void
}

class Cursor implements RevealCursor {
  readonly tracking = true
  private readonly pace = new RevealPace()
  private readonly walker: TreeWalker
  /** The DOM position of the first hidden character: (node, offset), `position` characters in. */
  private node: Text | null = null
  private offset = 0
  private position = 0
  private veil: AbstractRange | undefined
  private lastTick: number | undefined
  private finishing = false
  private drained = false
  private disposed = false
  private fallback: number | undefined

  constructor(
    private readonly clock: ClockInternals,
    private readonly root: HTMLElement,
    private readonly onDrained: (() => void) | undefined,
  ) {
    this.walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, SKIP_LABELS)
  }

  appended(characters: number): void {
    if (this.disposed) return
    this.pace.arrive(characters, this.clock.env.now())
    if (!this.clock.env.motionAllowed()) {
      this.showAll()
      return
    }
    // The old veil ended where the root ended; new text past it would show
    // for a frame. Repaint it before the browser paints.
    this.paint()
    if (this.position < this.pace.total) this.clock.wake(this)
  }

  reset(): void {
    if (this.disposed) return
    this.walker.currentNode = this.root
    this.node = null
    this.offset = 0
    this.position = 0
    this.showAll()
  }

  finish(): void {
    if (this.disposed || this.finishing) return
    this.finishing = true
    if (!this.clock.env.motionAllowed() || this.position >= this.pace.total) {
      this.showAll()
      this.drain()
      return
    }
    this.clock.wake(this)
    this.fallback = this.clock.env.setTimer(() => {
      this.fallback = undefined
      this.revealNow()
    }, FINISH_FALLBACK_MS)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.fallback !== undefined) this.clock.env.clearTimer(this.fallback)
    if (this.veil) this.clock.veil.delete(this.veil)
    this.veil = undefined
    this.clock.forget(this)
  }

  /** Shows everything at once; a finished reply has drained. */
  revealNow(): void {
    this.showAll()
    if (this.finishing) this.drain()
  }

  /** Everything in the DOM counts as shown, from now on. */
  private showAll(): void {
    if (this.disposed) return
    this.seek(Number.POSITIVE_INFINITY)
    this.pace.settle(this.position)
    this.lastTick = undefined
    this.paint()
  }

  /** One frame; returns whether the cursor needs another one. */
  step(now: number): boolean {
    if (this.disposed) return false
    const dt =
      this.lastTick === undefined ? FIRST_FRAME_MS : clamp(now - this.lastTick, 1, MAX_FRAME_MS)
    this.lastTick = now
    const target = Math.floor(this.pace.step(now, dt, this.finishing) + 1e-6)
    if (target > this.position) {
      this.seek(target)
      // Fewer characters in the DOM than were counted: what is there is all.
      if (this.position < target) this.pace.settle(this.position)
      this.paint()
    }
    if (this.position < this.pace.total) return true
    this.lastTick = undefined
    if (this.finishing) this.drain()
    return false
  }

  private drain(): void {
    if (this.drained) return
    this.drained = true
    if (this.fallback !== undefined) this.clock.env.clearTimer(this.fallback)
    this.fallback = undefined
    this.onDrained?.()
  }

  /** Moves the cursor forward to `target` characters, as far as the DOM goes. */
  private seek(target: number): void {
    let node = this.node
    let offset = this.offset
    let position = this.position
    while (position < target) {
      if (node && offset < node.length) {
        const step = Math.min(node.length - offset, target - position)
        offset += step
        position += step
        // Never between the halves of a surrogate pair.
        if (offset < node.length && isHighSurrogate(node.data.charCodeAt(offset - 1))) {
          offset += 1
          position += 1
        }
        continue
      }
      const next = this.walker.nextNode() as Text | null
      if (!next) break
      node = next
      offset = 0
    }
    this.node = node
    this.offset = offset
    this.position = position
  }

  private paint(): void {
    const previous = this.veil
    this.veil =
      this.position < this.pace.total
        ? this.clock.env.createRange({
            startContainer: this.node ?? this.root,
            startOffset: this.node ? this.offset : 0,
            endContainer: this.root,
            endOffset: this.root.childNodes.length,
          })
        : undefined
    if (previous) this.clock.veil.delete(previous)
    if (this.veil) this.clock.veil.add(this.veil)
  }
}

/** Where nothing is ever veiled: no API, so text shows as it lands. */
class InertCursor implements RevealCursor {
  readonly tracking = false
  private drained = false
  constructor(private readonly onDrained: (() => void) | undefined) {}
  appended(): void {}
  reset(): void {}
  finish(): void {
    if (this.drained) return
    this.drained = true
    this.onDrained?.()
  }
  dispose(): void {}
}

export function createRevealClock(env: RevealEnvironment): RevealClock {
  const veil = env.highlight(REVEAL_VEIL)
  if (!veil) {
    return {
      attach: (_root, options) => new InertCursor(options?.onDrained),
      enabled: () => false,
    }
  }
  const attached = new Set<Cursor>()
  const awake = new Set<Cursor>()
  let frame: number | undefined
  const tick = (now: number) => {
    frame = undefined
    for (const cursor of awake) if (!cursor.step(now)) awake.delete(cursor)
    if (awake.size > 0) frame = env.requestFrame(tick)
  }
  const internals: ClockInternals = {
    env,
    veil,
    wake(cursor) {
      awake.add(cursor)
      frame ??= env.requestFrame(tick)
    },
    forget(cursor) {
      attached.delete(cursor)
      awake.delete(cursor)
      if (awake.size === 0 && frame !== undefined) {
        env.cancelFrame(frame)
        frame = undefined
      }
    },
  }
  env.onMotionChange(() => {
    if (env.motionAllowed()) return
    for (const cursor of attached) cursor.revealNow()
  })
  return {
    attach(root, options) {
      const cursor = new Cursor(internals, root, options?.onDrained)
      attached.add(cursor)
      return cursor
    },
    enabled: () => env.motionAllowed(),
  }
}

function browserEnvironment(): RevealEnvironment {
  const supported =
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof Highlight === 'function' &&
    typeof StaticRange === 'function'
  const reducedMotion =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : undefined
  return {
    now: () => performance.now(),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    highlight(name) {
      if (!supported) return undefined
      const existing = CSS.highlights.get(name)
      if (existing) return existing
      const highlight = new Highlight()
      CSS.highlights.set(name, highlight)
      return highlight
    },
    createRange: (init) => new StaticRange(init),
    motionAllowed: () => !reducedMotion?.matches && document.visibilityState !== 'hidden',
    onMotionChange(listener) {
      reducedMotion?.addEventListener('change', listener)
      document.addEventListener('visibilitychange', listener)
    },
  }
}

let defaultClock: RevealClock | undefined

/** The app-wide clock: one animation frame loop for every live message. */
export function revealClock(): RevealClock {
  return (defaultClock ??= createRevealClock(browserEnvironment()))
}

/** Tests swap in a clock driven by their own frames; undefined restores the browser's. */
export function replaceRevealClock(clock: RevealClock | undefined): void {
  defaultClock = clock
}
