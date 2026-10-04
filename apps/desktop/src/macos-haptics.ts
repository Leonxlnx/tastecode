import { spawn } from 'node:child_process'
import type { Writable } from 'node:stream'

export type MacHapticPattern = 'alignment' | 'generic'

type HapticHelperProcess = {
  stdin: Writable
  once: (event: 'error' | 'exit', listener: () => void) => HapticHelperProcess
  kill: () => boolean
}

type MacOSHapticsOptions = {
  platform?: NodeJS.Platform
  spawnHelper?: () => HapticHelperProcess
  now?: () => number
}

const PATTERN_COMMAND = {
  generic: '0',
  alignment: '1',
} as const satisfies Record<MacHapticPattern, string>

const MIN_FEEDBACK_INTERVAL_MS = 28
const HELPER_IDLE_MS = 8_000

/**
 * JXA gives the Electron shell a small, ABI-independent path to AppKit. The
 * helper stays blocked on stdin between pulses, so a resize never launches a
 * process per pointer event. Commands are fixed single bytes, not executable
 * input from the renderer.
 */
const HAPTIC_HELPER_SOURCE = String.raw`
ObjC.import('AppKit')

const input = $.NSFileHandle.fileHandleWithStandardInput
const performanceTimeNow = 1
let lastFeedbackAt = 0
while (true) {
  const data = input.availableData
  if (Number(data.length) === 0) break

  const commands = ObjC.unwrap(
    $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
  )
  for (const command of commands) {
    if (command !== '0' && command !== '1') continue
    const now = Date.now()
    if (now - lastFeedbackAt < ${MIN_FEEDBACK_INTERVAL_MS}) continue
    $.NSHapticFeedbackManager.defaultPerformer.performFeedbackPatternPerformanceTime(
      Number(command),
      performanceTimeNow
    )
    lastFeedbackAt = now
  }
}
`

function spawnHapticHelper(): HapticHelperProcess {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', HAPTIC_HELPER_SOURCE], {
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  if (!child.stdin) throw new Error('macOS haptic helper has no input pipe')
  return child
}

/** Low-latency, macOS-only AppKit haptics with a hard flood limit. */
export class MacOSHaptics {
  readonly #spawnHelper: () => HapticHelperProcess
  readonly #now: () => number
  #available: boolean
  #child: HapticHelperProcess | undefined
  #idleTimer: NodeJS.Timeout | undefined
  #pendingGenericTimer: NodeJS.Timeout | undefined
  #genericPending = false
  #lastFeedbackAt = Number.NEGATIVE_INFINITY

  constructor(options: MacOSHapticsOptions = {}) {
    this.#available = (options.platform ?? process.platform) === 'darwin'
    this.#spawnHelper = options.spawnHelper ?? spawnHapticHelper
    this.#now = options.now ?? Date.now
  }

  prepare(): void {
    if (!this.#available || this.#child) return

    let child: HapticHelperProcess
    try {
      child = this.#spawnHelper()
    } catch {
      this.#available = false
      return
    }

    this.#child = child
    const disable = () => this.#disable(child)
    child.once('error', disable)
    child.once('exit', disable)
    child.stdin.once('error', disable)
    this.#armIdleTimer()
  }

  perform(pattern: MacHapticPattern): void {
    if (!this.#available) return
    const now = this.#now()

    // A collapse/unfold cue carries more meaning than an intermediate width
    // tick. Keep the earliest generic cue pending through the flood window,
    // and let alignment cues drop while it waits.
    if (this.#genericPending) {
      if (now - this.#lastFeedbackAt < MIN_FEEDBACK_INTERVAL_MS) return
      this.#clearPendingGeneric()
      this.#writeFeedback('generic', now)
      return
    }

    const remaining = MIN_FEEDBACK_INTERVAL_MS - (now - this.#lastFeedbackAt)
    if (remaining > 0) {
      if (pattern === 'generic') this.#queueGeneric(remaining)
      return
    }

    this.#writeFeedback(pattern, now)
  }

  stop(): void {
    this.#available = false
    this.#clearPendingGeneric()
    this.#clearIdleTimer()
    this.#closeChild()
  }

  #writeFeedback(pattern: MacHapticPattern, now: number): void {
    this.prepare()
    const child = this.#child
    if (!child || child.stdin.destroyed || !child.stdin.writable) return

    try {
      child.stdin.write(PATTERN_COMMAND[pattern])
    } catch {
      this.#disable(child)
      return
    }

    this.#lastFeedbackAt = now
    this.#armIdleTimer()
  }

  #queueGeneric(remaining: number): void {
    this.prepare()
    const child = this.#child
    if (!child || child.stdin.destroyed || !child.stdin.writable) return

    this.#genericPending = true
    if (this.#pendingGenericTimer) return
    this.#pendingGenericTimer = setTimeout(
      () => {
        this.#pendingGenericTimer = undefined
        if (!this.#genericPending || !this.#available) return

        const now = this.#now()
        const nextRemaining = MIN_FEEDBACK_INTERVAL_MS - (now - this.#lastFeedbackAt)
        if (nextRemaining > 0) {
          this.#queueGeneric(nextRemaining)
          return
        }

        this.#genericPending = false
        this.#writeFeedback('generic', now)
      },
      Math.ceil(remaining) + 1,
    )
    this.#pendingGenericTimer.unref()
  }

  #clearPendingGeneric(): void {
    if (this.#pendingGenericTimer) clearTimeout(this.#pendingGenericTimer)
    this.#pendingGenericTimer = undefined
    this.#genericPending = false
  }

  #armIdleTimer(): void {
    this.#clearIdleTimer()
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      this.#closeChild()
    }, HELPER_IDLE_MS)
    this.#idleTimer.unref()
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
  }

  #closeChild(): void {
    const child = this.#child
    if (!child) return
    // Clear identity first so the expected exit does not permanently disable
    // a helper that may be started again for the next resize.
    this.#child = undefined
    child.stdin.end()
    child.kill()
  }

  #disable(child: HapticHelperProcess): void {
    if (this.#child !== child) return
    this.#child = undefined
    this.#available = false
    this.#clearPendingGeneric()
    this.#clearIdleTimer()
    child.kill()
  }
}

export function isMacHapticPattern(value: unknown): value is MacHapticPattern {
  return value === 'alignment' || value === 'generic'
}
