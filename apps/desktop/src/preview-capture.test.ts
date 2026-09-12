import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewCaptureOwner } from './preview-capture.js'
import { PREVIEW_PAGE_HEIGHT_SCRIPT } from './preview-settle.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const request = (index = 1) => ({
  requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  url: 'http://127.0.0.1:5189',
  viewports: [{ width: 1280, height: 720 }],
})

function fixture() {
  const session = {
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
  }
  const contents = {
    session,
    getURL: vi.fn(() => request().url),
    executeJavaScriptInIsolatedWorld: vi.fn(
      async (_world: number, scripts: Array<{ code: string }>) =>
        scripts[0]!.code === PREVIEW_PAGE_HEIGHT_SCRIPT
          ? { body: 100_000_000, documentElement: 100_000_000 }
          : undefined,
    ),
    capturePage: vi.fn().mockResolvedValue({ toPNG: () => Buffer.from('png') }),
  }
  const windows: Array<{ destroy: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn> }> =
    []
  const createWindow = vi.fn(() => {
    let destroyed = false
    const window = {
      loadURL: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(() => {
        destroyed = true
      }),
      isDestroyed: () => destroyed,
      setContentSize: vi.fn(),
      get webContents() {
        if (destroyed) throw new Error('Object has been destroyed')
        return contents
      },
    }
    windows.push(window)
    // The fixture implements every BrowserWindow member used by the owner.
    return window as unknown as BrowserWindow
  })
  const files = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  }
  const dependencies = {
    createWindow,
    releaseWindow: vi.fn(),
    directory: (id: string) => path.join('test-captures', id),
    parseAudit: vi.fn().mockResolvedValue({ h1Count: 1, interactiveTargetViolations: [] }),
    files,
    timeoutMs: 50,
    cleanupTimeoutMs: 10,
  }
  return {
    dependencies,
    files,
    contents,
    session,
    windows,
    createWindow,
    owner: new PreviewCaptureOwner(dependencies),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('desktop preview capture ownership', () => {
  it('cancels validation from the closed window epoch before a job is registered', async () => {
    const test = fixture()
    const validation = deferred<() => ReturnType<typeof request>>()
    const result = test.owner.captureAfterValidation(
      request(),
      () => validation.promise,
      () => true,
    )
    test.owner.cancelAll()
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview capture cancelled',
    })
    const parse = vi.fn(() => request())
    validation.resolve(parse)
    await Promise.resolve()
    expect(parse).not.toHaveBeenCalled()
    expect(test.createWindow).not.toHaveBeenCalled()
    // A new app window may capture, without reviving the previous window's call.
    await expect(
      test.owner.captureAfterValidation(
        request(2),
        async () => () => request(2),
        () => true,
      ),
    ).resolves.toMatchObject({ status: 'completed' })
    expect(test.createWindow).toHaveBeenCalledOnce()
  })

  it('rechecks the capture source after validation even without a global cancellation', async () => {
    const test = fixture()
    const validation = deferred<() => ReturnType<typeof request>>()
    let allowed = true
    const result = test.owner.captureAfterValidation(
      request(),
      () => validation.promise,
      () => allowed,
    )
    allowed = false
    validation.resolve(() => request())
    await expect(result).resolves.toMatchObject({ status: 'failed' })
    expect(test.createWindow).not.toHaveBeenCalled()
  })

  it('cancels one pending validation by request id while another can still capture', async () => {
    const test = fixture()
    const validation = deferred<() => ReturnType<typeof request>>()
    const cancelled = test.owner.captureAfterValidation(
      request(),
      () => validation.promise,
      () => true,
    )
    const retained = test.owner.captureAfterValidation(
      request(2),
      () => validation.promise,
      () => true,
    )
    test.owner.cancel(request().requestId)
    await expect(cancelled).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview capture cancelled',
    })
    const parse = vi.fn(() => request(2))
    validation.resolve(parse)
    await expect(retained).resolves.toMatchObject({ status: 'completed' })
    expect(parse).toHaveBeenCalledOnce()
    expect(parse).toHaveBeenCalledWith(request(2))
    expect(test.createWindow).toHaveBeenCalledOnce()
  })

  it('rejects a dead capture source before starting validation', async () => {
    const test = fixture()
    const validate = vi.fn(async () => () => request())
    await expect(
      test.owner.captureAfterValidation(request(), validate, () => false),
    ).rejects.toThrow('requires a live app renderer')
    expect(validate).not.toHaveBeenCalled()
    expect(test.createWindow).not.toHaveBeenCalled()
  })

  it('bounds a stalled validator and never parses its late result', async () => {
    vi.useFakeTimers()
    const test = fixture()
    const validation = deferred<() => ReturnType<typeof request>>()
    const result = test.owner.captureAfterValidation(
      request(),
      () => validation.promise,
      () => true,
    )
    await vi.advanceTimersByTimeAsync(51)
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview capture timed out',
    })
    const parse = vi.fn(() => request())
    validation.resolve(parse)
    await vi.advanceTimersByTimeAsync(0)
    expect(parse).not.toHaveBeenCalled()
    expect(test.createWindow).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('transfers only the remaining deadline from validation to the native job', async () => {
    vi.useFakeTimers()
    const test = fixture()
    test.files.mkdir.mockReturnValueOnce(new Promise(() => undefined))
    const validation = deferred<() => ReturnType<typeof request>>()
    const result = test.owner.captureAfterValidation(
      request(),
      () => validation.promise,
      () => true,
    )
    await vi.advanceTimersByTimeAsync(40)
    validation.resolve(() => request())
    await vi.advanceTimersByTimeAsync(0)
    expect(test.createWindow).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(11)
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview capture timed out',
    })
    expect(test.windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts validation and native jobs together and releases both on cancelAll', async () => {
    vi.useFakeTimers()
    const test = fixture()
    test.files.mkdir.mockReturnValueOnce(new Promise(() => undefined))
    const jobs = [test.owner.capture(request())]
    const validation = deferred<() => ReturnType<typeof request>>()
    for (let index = 2; index <= 8; index += 1)
      jobs.push(
        test.owner.captureAfterValidation(
          request(index),
          () => validation.promise,
          () => true,
        ),
      )
    const nextLoader = vi.fn(async () => () => request(9))
    await expect(
      test.owner.captureAfterValidation(request(9), nextLoader, () => true),
    ).resolves.toMatchObject({ status: 'failed', error: 'Preview capture queue is full' })
    expect(nextLoader).not.toHaveBeenCalled()
    await expect(test.owner.capture(request(10))).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview capture queue is full',
    })
    test.owner.cancelAll()
    for (const result of await Promise.all(jobs))
      expect(result).toMatchObject({ status: 'failed', error: 'Preview capture cancelled' })
    expect(vi.getTimerCount()).toBe(0)
    await expect(test.owner.capture(request(11))).resolves.toMatchObject({ status: 'completed' })
    expect(test.createWindow).toHaveBeenCalledTimes(2)
  })

  it('measures only in an isolated world and caps native allocation in the main process', async () => {
    const test = fixture()
    await expect(test.owner.capture(request())).resolves.toMatchObject({ status: 'completed' })
    expect(test.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(3)
    for (const [world] of test.contents.executeJavaScriptInIsolatedWorld.mock.calls)
      expect(world).toBe(1001)
    expect(test.contents.capturePage).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 1280,
      height: 12_000,
    })
    expect(test.windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(test.session.clearCache).toHaveBeenCalledOnce()
  })

  it('keeps the next window closed until both cleanup operations complete', async () => {
    vi.useFakeTimers()
    const test = fixture()
    const cleanup = deferred<void>()
    test.session.clearCache.mockReturnValueOnce(cleanup.promise)
    const first = test.owner.capture(request())
    const second = test.owner.capture(request(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(test.session.clearCache).toHaveBeenCalledOnce()
    expect(test.createWindow).toHaveBeenCalledOnce()
    cleanup.resolve()
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    await expect(second).resolves.toMatchObject({ status: 'completed' })
    expect(test.createWindow).toHaveBeenCalledTimes(2)
  })

  it('preserves repeated viewport results while writing one exclusive file per size', async () => {
    const test = fixture()
    const capture = request()
    capture.viewports.push({ ...capture.viewports[0]! })
    const result = await test.owner.capture(capture)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error(result.error)
    expect(result.screenshots).toHaveLength(2)
    expect(result.screenshots[1]).toEqual(result.screenshots[0])
    expect(test.files.writeFile).toHaveBeenCalledOnce()
  })

  it('returns a failed IPC result on cleanup failure and refuses the queued and future jobs', async () => {
    const test = fixture()
    test.session.clearStorageData.mockRejectedValue(new Error('cannot clear storage'))
    const first = test.owner.capture(request())
    const second = test.owner.capture(request(2))
    await expect(first).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview storage cleanup failed',
    })
    await expect(second).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('restart the app'),
    })
    await expect(test.owner.capture(request(3))).resolves.toMatchObject({ status: 'failed' })
    expect(test.createWindow).toHaveBeenCalledOnce()
    expect(test.session.clearCache).toHaveBeenCalledOnce()
    expect(test.files.rm).toHaveBeenCalledOnce()
  })

  it('bounds hung cleanup, attempts both operations, and never reuses its partition', async () => {
    vi.useFakeTimers()
    const test = fixture()
    test.session.clearStorageData.mockReturnValue(new Promise(() => undefined))
    const result = test.owner.capture(request())
    await vi.advanceTimersByTimeAsync(11)
    await expect(result).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview cleanup timed out',
    })
    expect(test.session.clearCache).toHaveBeenCalledOnce()
    await expect(test.owner.capture(request(2))).resolves.toMatchObject({ status: 'failed' })
    expect(test.createWindow).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['mkdir', 'load', 'settle', 'audit', 'height', 'capture', 'write'] as const)(
    'bounds %s, destroys its window, and ignores its late result',
    async (stage) => {
      vi.useFakeTimers()
      const test = fixture()
      const pending = deferred<never>()
      if (stage === 'mkdir') test.files.mkdir.mockReturnValueOnce(pending.promise)
      if (stage === 'load') {
        const create = test.createWindow.getMockImplementation()!
        test.createWindow.mockImplementationOnce(() => {
          const window = create()
          test.windows[0]!.loadURL.mockReturnValueOnce(pending.promise)
          return window
        })
      }
      if (stage === 'settle')
        test.contents.executeJavaScriptInIsolatedWorld.mockReturnValueOnce(pending.promise)
      if (stage === 'audit') test.dependencies.parseAudit.mockReturnValueOnce(pending.promise)
      if (stage === 'height')
        test.contents.executeJavaScriptInIsolatedWorld
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockReturnValueOnce(pending.promise)
      if (stage === 'capture') test.contents.capturePage.mockReturnValueOnce(pending.promise)
      if (stage === 'write') test.files.writeFile.mockReturnValueOnce(pending.promise)
      const result = test.owner.capture(request())
      await vi.advanceTimersByTimeAsync(51)
      await expect(result).resolves.toMatchObject({
        status: 'failed',
        error: 'Preview capture timed out',
      })
      expect(test.windows[0]!.destroy).toHaveBeenCalledOnce()
      expect(test.session.clearCache).toHaveBeenCalledOnce()
      if (stage === 'write')
        expect(test.files.writeFile.mock.calls[0]![2].signal.aborted).toBe(true)
      const callsBefore = test.files.writeFile.mock.calls.length
      pending.resolve(undefined as never)
      await vi.advanceTimersByTimeAsync(1)
      expect(test.files.writeFile).toHaveBeenCalledTimes(callsBefore)
      await expect(test.owner.capture(request(2))).resolves.toMatchObject({ status: 'completed' })
      expect(test.createWindow).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('cancels active and queued jobs without waiting for their deadlines', async () => {
    const test = fixture()
    test.files.mkdir.mockReturnValueOnce(new Promise(() => undefined))
    const first = test.owner.capture(request())
    const second = test.owner.capture(request(2))
    test.owner.cancelAll()
    expect(test.windows[0]!.destroy).toHaveBeenCalledOnce()
    await expect(first).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview capture cancelled',
    })
    await expect(second).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview capture cancelled',
    })
    expect(test.createWindow).toHaveBeenCalledOnce()
  })

  it('bounds the waiting queue and rejects duplicate request ownership', async () => {
    const test = fixture()
    test.files.mkdir.mockReturnValueOnce(new Promise(() => undefined))
    const jobs = Array.from({ length: 8 }, (_, index) => test.owner.capture(request(index + 1)))
    await expect(test.owner.capture(request())).resolves.toMatchObject({
      status: 'failed',
      error: 'Duplicate preview capture',
    })
    await expect(test.owner.capture(request(9))).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview capture queue is full',
    })
    test.owner.cancelAll()
    await Promise.all(jobs)
  })

  it('honors cancellation that reaches IPC before async request validation finishes', async () => {
    const test = fixture()
    test.owner.cancel(request().requestId)
    await expect(test.owner.capture(request())).resolves.toMatchObject({
      status: 'failed',
      error: 'Preview capture cancelled',
    })
    expect(test.createWindow).not.toHaveBeenCalled()
    await expect(test.owner.capture(request(2))).resolves.toMatchObject({ status: 'completed' })
  })

  it('expires early-cancellation tombstones without holding a timer open', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const test = fixture()
    test.owner.cancel(request().requestId)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_001)
    await expect(test.owner.capture(request())).resolves.toMatchObject({ status: 'completed' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
