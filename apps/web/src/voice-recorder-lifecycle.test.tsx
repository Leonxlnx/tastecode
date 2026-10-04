// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVoiceRecorder } from './voice-recorder.js'

vi.mock('./voice-capability.js', () => ({ canCaptureVoice: () => true }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('voice startup lifetime', () => {
  it('stops a late permission stream without starting an audio context', async () => {
    const permission = deferred<MediaStream>()
    const stop = vi.fn()
    const Audio = vi.fn()
    vi.stubGlobal('AudioContext', Audio)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission.promise } })
    const view = renderHook(() => useVoiceRecorder())
    let outcome!: Promise<unknown>
    act(() => {
      outcome = view.result.current.start().catch((error: unknown) => error)
    })
    await act(() => view.result.current.cancel())
    await act(async () => {
      permission.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
      expect(await outcome).toMatchObject({ name: 'AbortError' })
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(Audio).not.toHaveBeenCalled()
    expect(view.result.current.recording).toBe(false)
  })

  it('closes resources at unmount while audio resume is still pending', async () => {
    const resumed = deferred<void>()
    const stopped = vi.fn()
    const closed = vi.fn(async () => {})
    const source = vi.fn()
    vi.stubGlobal(
      'AudioContext',
      class {
        resume = () => resumed.promise
        close = closed
        createMediaStreamSource = source
      },
    )
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopped }] }) },
    })
    const view = renderHook(() => useVoiceRecorder())
    let outcome!: Promise<unknown>
    await act(async () => {
      outcome = view.result.current.start().catch((error: unknown) => error)
    })
    view.unmount()
    expect(stopped).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
    resumed.resolve()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(source).not.toHaveBeenCalled()
    expect(stopped).toHaveBeenCalledOnce()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('keeps a newer permission request owned when the cancelled one settles', async () => {
    const first = deferred<MediaStream>()
    const second = deferred<MediaStream>()
    const stopFirst = vi.fn(),
      stopSecond = vi.fn()
    const getUserMedia = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const view = renderHook(() => useVoiceRecorder())
    const oldStart = view.result.current.start().catch((error: unknown) => error)
    await act(() => view.result.current.cancel())
    const newStart = view.result.current.start().catch((error: unknown) => error)
    first.resolve({ getTracks: () => [{ stop: stopFirst }] } as unknown as MediaStream)
    await oldStart
    await expect(view.result.current.start()).rejects.toThrow('already running')
    await act(() => view.result.current.cancel())
    second.resolve({ getTracks: () => [{ stop: stopSecond }] } as unknown as MediaStream)
    await newStart
    expect(stopFirst).toHaveBeenCalledOnce()
    expect(stopSecond).toHaveBeenCalledOnce()
  })
})
