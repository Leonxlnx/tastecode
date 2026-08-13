import {
  isDesktop,
  isMacOS,
  performNativeHaptic,
  prepareNativeHaptics,
  type NativeHapticPattern,
} from './bridge.js'

export const HAPTICS_KEY = 'harness.haptics'
export const LEGACY_HAPTICS_KEY = 'harness.sidebarHaptics'
const CHANGE_EVENT = 'harness:haptics'
const BASE_DETENT_PX = 8
const DETENT_REARM_PX = 8
const MIN_DETENT_PX = 16
const MAX_DETENT_PX = 40
const DENSE_DRAG_PX_PER_MS = 0.18
const SPARSE_DRAG_PX_PER_MS = 1.2
const VELOCITY_TIME_CONSTANT_MS = 48
let sessionPreference: boolean | undefined

export type ResizeHapticSample = {
  /** Pointer-derived value before the visual min/max clamp. */
  rawValue: number
  /** The clamped value currently rendered by the surface. */
  value: number
  /** True only while the rendered surface is following this pointer sample. */
  tracking: boolean
  time: number
}

type ResizeHapticsOptions = {
  startValue: number
  startTime: number
  minValue: number
  maxValue: number
}

/** Enabled by default on supported Macs; the settings toggle can opt out. */
export function readAppHaptics(): boolean {
  if (sessionPreference !== undefined) return sessionPreference
  try {
    const preference = localStorage.getItem(HAPTICS_KEY)
    const legacyPreference = localStorage.getItem(LEGACY_HAPTICS_KEY)
    return (preference ?? legacyPreference) !== 'false'
  } catch {
    return true
  }
}

export function writeAppHaptics(enabled: boolean): void {
  try {
    localStorage.setItem(HAPTICS_KEY, String(enabled))
    localStorage.removeItem(LEGACY_HAPTICS_KEY)
    sessionPreference = undefined
  } catch {
    sessionPreference = enabled
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeAppHaptics(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

export function appHapticsSupported(): boolean {
  return isDesktop && isMacOS()
}

export function appHapticsEnabled(): boolean {
  return appHapticsSupported() && readAppHaptics()
}

export function prepareAppHaptics(): void {
  if (appHapticsEnabled()) prepareNativeHaptics()
}

export function performAppHaptic(pattern: NativeHapticPattern): void {
  if (appHapticsEnabled()) performNativeHaptic(pattern)
}

/**
 * Stateful alignment filter for any one-dimensional resize gesture. A
 * time-correct velocity filter eases between stable 16–40 px grids, so the
 * tactile cadence changes without abrupt density jumps. Feedback is silent
 * whenever the rendered surface is clamped or settling instead of tracking.
 */
export class ResizeHaptics {
  readonly #minValue: number
  readonly #maxValue: number
  #previousRawValue: number
  #previousValue: number
  #previousTime: number
  #velocity = 0
  #hasVelocity = false
  #latchedBoundary: 'min' | 'max' | undefined
  #latchedDetent: number | undefined

  constructor(options: ResizeHapticsOptions) {
    this.#minValue = options.minValue
    this.#maxValue = options.maxValue
    this.#previousRawValue = options.startValue
    this.#previousValue = options.startValue
    this.#previousTime = options.startTime
  }

  sample(sample: ResizeHapticSample): NativeHapticPattern | undefined {
    const previousValue = this.#previousValue

    this.#updateVelocity(sample.rawValue, sample.time)
    this.#previousRawValue = sample.rawValue
    this.#previousValue = sample.value
    this.#previousTime = sample.time
    this.#rearmStops(sample.rawValue, sample.value)

    if (!sample.tracking) return undefined

    const hitMin = previousValue > this.#minValue && sample.value === this.#minValue
    const hitMax = previousValue < this.#maxValue && sample.value === this.#maxValue

    if (hitMin && this.#latchedBoundary !== 'min') {
      this.#latchedBoundary = 'min'
      this.#latchedDetent = undefined
      return 'alignment'
    }
    if (hitMax && this.#latchedBoundary !== 'max') {
      this.#latchedBoundary = 'max'
      this.#latchedDetent = undefined
      return 'alignment'
    }
    if (sample.value <= this.#minValue || sample.value >= this.#maxValue) return undefined

    const detent = crossedDetent(
      previousValue,
      sample.value,
      this.#minValue,
      this.#maxValue,
      this.#detentStride(),
    )
    if (detent === undefined || detent === this.#latchedDetent) return undefined
    this.#latchedDetent = detent
    return 'alignment'
  }

  #updateVelocity(rawValue: number, time: number): void {
    const elapsed = time - this.#previousTime
    const duration = elapsed > 0 ? Math.min(64, Math.max(4, elapsed)) : 16
    const instantaneous = Math.abs(rawValue - this.#previousRawValue) / duration
    const retainedVelocity = Math.exp(-duration / VELOCITY_TIME_CONSTANT_MS)
    this.#velocity = this.#hasVelocity
      ? this.#velocity * retainedVelocity + instantaneous * (1 - retainedVelocity)
      : instantaneous
    this.#hasVelocity = true
  }

  #detentStride(): number {
    const velocityRange = SPARSE_DRAG_PX_PER_MS - DENSE_DRAG_PX_PER_MS
    const progress = Math.min(
      1,
      Math.max(0, (this.#velocity - DENSE_DRAG_PX_PER_MS) / velocityRange),
    )
    const easedProgress = progress * progress * (3 - 2 * progress)
    const continuousStride = MIN_DETENT_PX + (MAX_DETENT_PX - MIN_DETENT_PX) * easedProgress
    return Math.round(continuousStride / BASE_DETENT_PX) * BASE_DETENT_PX
  }

  #rearmStops(rawValue: number, value: number): void {
    if (this.#latchedBoundary === 'min' && rawValue >= this.#minValue + DETENT_REARM_PX) {
      this.#latchedBoundary = undefined
    } else if (this.#latchedBoundary === 'max' && rawValue <= this.#maxValue - DETENT_REARM_PX) {
      this.#latchedBoundary = undefined
    }

    if (
      this.#latchedDetent !== undefined &&
      Math.abs(value - this.#latchedDetent) >= DETENT_REARM_PX
    ) {
      this.#latchedDetent = undefined
    }
  }
}

function crossedDetent(
  previousValue: number,
  nextValue: number,
  minValue: number,
  maxValue: number,
  stride: number,
): number | undefined {
  if (previousValue === nextValue) return undefined
  const strideSteps = stride / BASE_DETENT_PX

  if (nextValue > previousValue) {
    let index = Math.floor((previousValue - minValue) / BASE_DETENT_PX) + 1
    const lastIndex = Math.floor((nextValue - minValue) / BASE_DETENT_PX)
    const remainder = index % strideSteps
    if (remainder !== 0) index += strideSteps - remainder
    const detent = minValue + index * BASE_DETENT_PX
    return index > 0 && index <= lastIndex && detent <= maxValue - MIN_DETENT_PX
      ? detent
      : undefined
  }

  let index = Math.ceil((previousValue - minValue) / BASE_DETENT_PX) - 1
  const lastIndex = Math.ceil((nextValue - minValue) / BASE_DETENT_PX)
  index -= index % strideSteps
  const detent = minValue + index * BASE_DETENT_PX
  return index > 0 && index >= lastIndex && detent <= maxValue - MIN_DETENT_PX ? detent : undefined
}
