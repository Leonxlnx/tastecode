/**
 * Following the end of a growing transcript.
 *
 * A streamed reply grows by one wrapped line at a time. Writing each new end
 * straight into scrollTop moved the whole transcript up by a full line about
 * ten times a second, with no motion in between. The glide here chases the
 * end with a critically damped spring instead: it leaves rest gently, never
 * overshoots, and an end that moves while it is under way is picked up on the
 * next frame without restarting the motion.
 *
 * Per frame it costs one scrollTop write and a few multiplications. It never
 * reads layout; whoever owns the scroller tells it where the end is.
 */

/** Smoothing time of the follow glide; a step is about 95% covered after 3x this. */
export const FOLLOW_SMOOTH_MS = 110
/** The longest frame step integrated at once, so a stalled frame does not leap. */
const MAX_STEP_MS = 32
/** Assumed duration of the first frame of a glide. */
const FIRST_STEP_MS = 16
/** Closer than this, and slower than SETTLE_SPEED, the glide lands. */
const SETTLE_PX = 0.5
/** px/ms */
const SETTLE_SPEED = 0.02

export interface Damped {
  pos: number
  /** px/ms */
  vel: number
}

/**
 * One step of a critically damped spring from `pos` towards `target`
 * (Game Programming Gems 4, 1.10). Stable for any step length, and clamped so
 * it never crosses the target: past the end the browser would clamp the
 * scroll, and the way back would read as a bounce.
 */
export function smoothDamp(
  pos: number,
  target: number,
  vel: number,
  smoothMs: number,
  dt: number,
): Damped {
  const omega = 2 / smoothMs
  const x = omega * dt
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = pos - target
  const temp = (vel + omega * change) * dt
  const nextVel = (vel - omega * temp) * decay
  const nextPos = target + (change + temp) * decay
  const crossed = change === 0 || (change < 0 ? nextPos >= target : nextPos <= target)
  return crossed ? { pos: target, vel: 0 } : { pos: nextPos, vel: nextVel }
}

export interface FollowGlide {
  /**
   * Glide towards `target`. An idle glide starts from `from` with `velocity`
   * (px/ms); a running one keeps its own position and speed and only aims
   * somewhere new.
   */
  setTarget(target: number, from: number, velocity?: number): void
  /** Someone else moved the scroll (a virtual-list correction, a clamp): continue from there. */
  sync(position: number): void
  stop(): void
  readonly running: boolean
  /** Where the glide last put the scroll, or would have if it were not snapped to device pixels. */
  readonly position: number
  readonly target: number
}

export interface FollowGlideOptions {
  write: (top: number) => void
  smoothMs?: number
  /** Device pixels per CSS pixel; writes smaller than one device pixel are skipped. */
  pixelRatio?: () => number
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
}

export function createFollowGlide(options: FollowGlideOptions): FollowGlide {
  const smoothMs = options.smoothMs ?? FOLLOW_SMOOTH_MS
  const pixelRatio = options.pixelRatio ?? (() => window.devicePixelRatio || 1)
  const requestFrame =
    options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle))
  let pos = 0
  let vel = 0
  let target = 0
  let written = Number.NaN
  let last: number | undefined
  let frame: number | undefined

  // Writes land on the device-pixel grid, so the value read back from
  // scrollTop is the value written and a sub-pixel step is never lost to the
  // browser's own rounding: it accumulates in `pos` until it is a pixel.
  const put = (top: number) => {
    const ratio = pixelRatio()
    const snapped = Math.round(top * ratio) / ratio
    if (snapped === written) return
    written = snapped
    options.write(snapped)
  }

  const tick = (now: number) => {
    frame = undefined
    const dt = last === undefined ? FIRST_STEP_MS : Math.min(MAX_STEP_MS, Math.max(0, now - last))
    last = now
    const next = smoothDamp(pos, target, vel, smoothMs, dt)
    pos = next.pos
    vel = next.vel
    if (Math.abs(target - pos) < SETTLE_PX && Math.abs(vel) < SETTLE_SPEED) {
      pos = target
      vel = 0
      last = undefined
      // Land exactly: the end is an integer the owner compares against.
      if (target !== written) {
        written = target
        options.write(target)
      }
      return
    }
    put(pos)
    frame = requestFrame(tick)
  }

  return {
    setTarget(nextTarget, from, velocity = 0) {
      target = nextTarget
      if (frame !== undefined) return
      pos = from
      vel = velocity
      written = from
      last = undefined
      frame = requestFrame(tick)
    },
    sync(position) {
      pos = position
      written = position
    },
    stop() {
      if (frame !== undefined) cancelFrame(frame)
      frame = undefined
      vel = 0
      last = undefined
    },
    get running() {
      return frame !== undefined
    },
    get position() {
      return pos
    },
    get target() {
      return target
    },
  }
}
