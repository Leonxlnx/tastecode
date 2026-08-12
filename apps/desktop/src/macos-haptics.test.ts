import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MacOSHaptics, isMacHapticPattern } from './macos-haptics.js'

function fakeHelper() {
  const events = new EventEmitter()
  const stdin = new PassThrough()
  const writes: string[] = []
  stdin.on('data', (chunk: Buffer) => writes.push(chunk.toString()))
  const kill = vi.fn(() => true)
  return {
    helper: {
      stdin,
      once: events.once.bind(events),
      kill,
    },
    events,
    kill,
    writes,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('macOS haptics', () => {
  it('does nothing off macOS', () => {
    const spawnHelper = vi.fn()
    const haptics = new MacOSHaptics({ platform: 'win32', spawnHelper })

    haptics.prepare()
    haptics.perform('alignment')

    expect(spawnHelper).not.toHaveBeenCalled()
  })

  it('reuses one helper, filters alignment noise, and preserves semantic feedback', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const process = fakeHelper()
    const spawnHelper = vi.fn(() => process.helper)
    const haptics = new MacOSHaptics({
      platform: 'darwin',
      spawnHelper,
    })

    haptics.prepare()
    haptics.perform('alignment')
    vi.advanceTimersByTime(10)
    haptics.perform('alignment')
    haptics.perform('generic')

    expect(spawnHelper).toHaveBeenCalledOnce()
    expect(process.writes).toEqual(['1'])

    vi.advanceTimersByTime(18)
    expect(process.writes).toEqual(['1'])
    vi.advanceTimersByTime(1)
    expect(process.writes).toEqual(['1', '0'])

    vi.advanceTimersByTime(8_000)
    expect(process.kill).toHaveBeenCalledOnce()
  })

  it('cancels a queued semantic cue when stopped', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const process = fakeHelper()
    const haptics = new MacOSHaptics({
      platform: 'darwin',
      spawnHelper: () => process.helper,
    })

    haptics.perform('alignment')
    vi.advanceTimersByTime(10)
    haptics.perform('generic')
    haptics.stop()
    vi.advanceTimersByTime(100)

    expect(process.writes).toEqual(['1'])
    expect(process.kill).toHaveBeenCalledOnce()
  })

  it('stops retrying when the native helper fails', () => {
    const process = fakeHelper()
    const spawnHelper = vi.fn(() => process.helper)
    const haptics = new MacOSHaptics({ platform: 'darwin', spawnHelper })

    haptics.prepare()
    process.events.emit('error')
    haptics.perform('alignment')

    expect(process.kill).toHaveBeenCalledOnce()
    expect(spawnHelper).toHaveBeenCalledOnce()
  })
})

describe('haptic pattern validation', () => {
  it('accepts only the two patterns exposed by the preload bridge', () => {
    expect(isMacHapticPattern('alignment')).toBe(true)
    expect(isMacHapticPattern('generic')).toBe(true)
    expect(isMacHapticPattern('arbitrary-script')).toBe(false)
  })
})
