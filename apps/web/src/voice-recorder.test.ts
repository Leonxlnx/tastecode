// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeMicrophoneError,
  encodeMonoPcmWav,
  formatRecordingDuration,
  resampleLinear,
  useVoiceRecorder,
} from './voice-recorder.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function mediaStreamFixture() {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] }
  return { stop, stream }
}

describe('voice recorder utilities', () => {
  it('resamples capture audio to 24 kHz', () => {
    const input = Float32Array.from({ length: 48_000 }, (_, index) => index / 48_000)
    const output = resampleLinear(input, 48_000, 24_000)
    expect(output).toHaveLength(24_000)
    expect(output[12_000]).toBeCloseTo(0.5, 3)
  })

  it('writes a mono 16-bit PCM WAV header', () => {
    const wav = new DataView(encodeMonoPcmWav(new Float32Array(24_000), 24_000))
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(wav.buffer, offset, length))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(wav.getUint16(22, true)).toBe(1)
    expect(wav.getUint32(24, true)).toBe(24_000)
    expect(wav.getUint16(34, true)).toBe(16)
    expect(wav.getUint32(40, true)).toBe(48_000)
  })

  it('formats duration and explains microphone denial', () => {
    expect(formatRecordingDuration(65_500)).toBe('1:05')
    const denied = new Error('Permission denied')
    denied.name = 'NotAllowedError'
    expect(describeMicrophoneError(denied)).toMatch(/Allow it/i)
  })
})

describe('voice recorder lifecycle', () => {
  it('releases a permission result that arrives after unmount', async () => {
    const permission = deferred<ReturnType<typeof mediaStreamFixture>['stream']>()
    const getUserMedia = vi.fn(() => permission.promise)
    const AudioContext = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal('AudioContext', AudioContext)
    const setInterval = vi.spyOn(window, 'setInterval')
    const { stop, stream } = mediaStreamFixture()
    const { result, unmount } = renderHook(() => useVoiceRecorder())
    let startPromise = Promise.resolve()

    act(() => {
      startPromise = result.current.start()
    })
    unmount()
    await act(async () => {
      permission.resolve(stream)
      await startPromise
    })

    expect(stop).toHaveBeenCalledOnce()
    expect(AudioContext).not.toHaveBeenCalled()
    expect(setInterval).not.toHaveBeenCalled()
  })

  it('releases the stream and context when cancel wins the resume race', async () => {
    const resumed = deferred<void>()
    const { stop, stream } = mediaStreamFixture()
    const close = vi.fn(() => Promise.resolve())
    const resume = vi.fn(() => resumed.promise)
    const createMediaStreamSource = vi.fn()
    const AudioContext = vi.fn(function () {
      return { close, createMediaStreamSource, resume }
    })
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
    })
    vi.stubGlobal('AudioContext', AudioContext)
    const setInterval = vi.spyOn(window, 'setInterval')
    const { result } = renderHook(() => useVoiceRecorder())
    let startPromise = Promise.resolve()

    act(() => {
      startPromise = result.current.start()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(resume).toHaveBeenCalledOnce()

    await act(async () => {
      await result.current.cancel()
      resumed.resolve()
      await startPromise
    })

    expect(stop).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(createMediaStreamSource).not.toHaveBeenCalled()
    expect(setInterval).not.toHaveBeenCalled()
    expect(result.current.recording).toBe(false)
  })
})
