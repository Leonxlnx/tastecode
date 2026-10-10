import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdateController } from './app-updater.js'

function fakeUpdater() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: true,
    checkForUpdates: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  })
}

const info = { version: '0.1.0-beta.2' }

afterEach(() => vi.useRealTimers())

describe('app update controller', () => {
  it('waits for updater cleanup on disposal', async () => {
    let finish!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve
    })
    const updater = Object.assign(fakeUpdater(), { dispose: vi.fn(() => cleanup) })
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.7',
      enabled: true,
    })
    const result = controller.dispose()
    expect(result).toBe(cleanup)
    expect(updater.dispose).toHaveBeenCalledOnce()
    finish()
    await result
  })

  it('downloads an available beta once and installs only after it is ready', async () => {
    const updater = fakeUpdater()
    const states: string[] = []
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.1',
      enabled: true,
    })
    controller.subscribe((state) => states.push(state.status))

    updater.emit('checking-for-update')
    updater.emit('update-available', info)
    expect(controller.install()).toBe(false)
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce())
    updater.emit('download-progress', { percent: 54.6 })
    updater.emit('update-downloaded', info)

    expect(controller.state()).toEqual({
      status: 'ready',
      currentVersion: '0.1.0-beta.1',
      version: '0.1.0-beta.2',
    })
    expect(states).toEqual(['checking', 'downloading', 'downloading', 'ready'])
    expect(controller.install()).toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('stays inert outside a packaged build', async () => {
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.1',
      enabled: false,
    })

    await expect(controller.check()).resolves.toMatchObject({ status: 'unsupported' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks after startup and hourly while open, then stops on disposal', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.1',
      enabled: true,
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    controller.start()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    controller.dispose()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('follows the newest release including prereleases and retains a ready download', async () => {
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '1.0.0',
      enabled: true,
    })
    expect(updater.allowPrerelease).toBe(true)
    expect(updater.allowDowngrade).toBe(false)
    updater.emit('update-downloaded', { version: '1.0.1' })
    await expect(controller.check()).resolves.toMatchObject({ status: 'ready', version: '1.0.1' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('does not load the optional updater before the automatic check', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    const loadUpdater = vi.fn().mockResolvedValue(updater)
    const controller = createAppUpdateController({
      loadUpdater,
      currentVersion: '0.1.0-beta.1',
      enabled: true,
    })

    controller.start()
    expect(controller.state()).toMatchObject({ status: 'idle' })
    expect(loadUpdater).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(loadUpdater).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(loadUpdater).toHaveBeenCalledOnce()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('shares the lazy updater across concurrent checks', async () => {
    const updater = fakeUpdater()
    const loadUpdater = vi.fn().mockResolvedValue(updater)
    const controller = createAppUpdateController({
      loadUpdater,
      currentVersion: '0.1.0-beta.1',
      enabled: true,
    })

    const first = controller.check()
    const second = controller.check()

    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(loadUpdater).toHaveBeenCalledOnce()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('reports a lazy updater load failure', async () => {
    const loadUpdater = vi.fn().mockRejectedValue(new Error('Updater failed to load.'))
    const controller = createAppUpdateController({
      loadUpdater,
      currentVersion: '0.1.0-beta.1',
      enabled: true,
    })

    await expect(controller.check()).resolves.toEqual({
      status: 'error',
      currentVersion: '0.1.0-beta.1',
      error: 'Updater failed to load.',
    })
  })

  it('retries a lazy updater load after a transient failure', async () => {
    const updater = fakeUpdater()
    const loadUpdater = vi
      .fn()
      .mockRejectedValueOnce(new Error('Updater failed to load.'))
      .mockResolvedValueOnce(updater)
    const controller = createAppUpdateController({
      loadUpdater,
      currentVersion: '0.1.0-beta.1',
      enabled: true,
    })

    await expect(controller.check()).resolves.toMatchObject({ status: 'error' })
    await expect(controller.check()).resolves.toMatchObject({ status: 'error' })

    expect(loadUpdater).toHaveBeenCalledTimes(2)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('keeps a failed background check out of view and retries it with backoff', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    const offline = new Error('net::ERR_INTERNET_DISCONNECTED')
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('checking-for-update')
      updater.emit('error', offline)
      throw offline
    })
    const onError = vi.fn()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
      onError,
    })
    const states: string[] = []
    controller.subscribe((state) => states.push(state.status))

    controller.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(controller.state()).toEqual({ status: 'idle', currentVersion: '0.1.2' })
    expect(states).toEqual(['checking', 'idle'])
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(offline)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3)

    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available', { version: '0.1.2' })
    })
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(4)
    expect(controller.state()).toMatchObject({ status: 'current' })
    // A success returns to the hourly check.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(5)
    controller.dispose()
  })

  it('shows a background failure to a user who joined the attempt', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    let reject!: (error: Error) => void
    updater.checkForUpdates.mockImplementation(
      () => new Promise((_resolve, fail) => (reject = fail)),
    )
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(15_000)
    const joined = controller.check()
    reject(new Error('GitHub could not be reached.'))
    await expect(joined).resolves.toMatchObject({
      status: 'error',
      error: 'GitHub could not be reached.',
    })
    controller.dispose()
  })

  it('restores the last verdict when a background download fails, then retries', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available', { version: '0.1.2' })
    })
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(controller.state()).toMatchObject({ status: 'current' })
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.1.3' })
    })
    updater.downloadUpdate.mockRejectedValue(new Error('socket hang up'))
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(controller.state()).toEqual({
      status: 'current',
      currentVersion: '0.1.2',
      version: '0.1.2',
    })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('always shows a failed install of a ready update', async () => {
    const updater = fakeUpdater()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.1.3' })
      updater.emit('update-downloaded', { version: '0.1.3' })
    })
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })

    await expect(controller.check('background')).resolves.toMatchObject({ status: 'ready' })
    updater.emit('error', new Error('The update is not signed by TasteCode.'))
    expect(controller.state()).toMatchObject({
      status: 'error',
      error: 'The update is not signed by TasteCode.',
    })
  })

  it('waits for a rate limit to reset instead of retrying early', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(
      Object.assign(new Error('GitHub is limiting update checks.'), {
        retryAt: Date.now() + 15_000 + 40 * 60 * 1000,
      }),
    )
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(controller.state()).toMatchObject({ status: 'idle' })
    await vi.advanceTimersByTimeAsync(40 * 60 * 1000 - 1)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('checks soon after waking when the hourly check came due during sleep', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    controller.resume()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()

    // Wall-clock time moves on while the hourly timer stands still.
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000)
    controller.resume()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('answers a check during a background download without starting another', async () => {
    const updater = fakeUpdater()
    let finish!: () => void
    updater.downloadUpdate.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finish = () => resolve([])
        }),
    )
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.1.3' })
    })
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })

    await controller.check('background')
    await expect(controller.check()).resolves.toMatchObject({
      status: 'downloading',
      version: '0.1.3',
    })
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    finish()
  })

  it('settles on the hourly check after repeated background failures', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    updater.checkForUpdates.mockRejectedValue(new Error('offline'))
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })

    controller.start()
    for (const delay of [15_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 60 * 60_000])
      await vi.advanceTimersByTimeAsync(delay)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(6)
    expect(controller.state()).toMatchObject({ status: 'idle' })
    controller.dispose()
  })

  it('clears an earlier failure once a later check succeeds', async () => {
    const updater = fakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('update-not-available', { version: '0.1.2' })
    })
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })

    await expect(controller.check()).resolves.toMatchObject({ status: 'error' })
    await expect(controller.check()).resolves.toMatchObject({ status: 'current' })
  })

  it('stays inert when disabled, even on wake', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: false,
    })

    controller.start()
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000)
    controller.resume()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(controller.state()).toMatchObject({ status: 'unsupported' })
  })

  it('prepares after the last byte and ignores the native updater local copy', async () => {
    const updater = fakeUpdater()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.1.3' })
    })
    updater.downloadUpdate.mockReturnValue(new Promise(() => {}))
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })
    const states: string[] = []
    controller.subscribe((state) =>
      states.push(`${state.status}${state.progress === undefined ? '' : ` ${state.progress}`}`),
    )

    await controller.check()
    updater.emit('download-progress', { percent: 41.2 })
    updater.emit('download-progress', { percent: 100 })
    // electron-updater copies the prepared file and reports it from zero again.
    updater.emit('download-progress', { percent: 3 })
    updater.emit('download-progress', { percent: 100 })
    expect(controller.state()).toEqual({
      status: 'preparing',
      currentVersion: '0.1.2',
      version: '0.1.3',
    })
    await expect(controller.check()).resolves.toMatchObject({ status: 'preparing' })
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    updater.emit('update-downloaded', { version: '0.1.3' })
    expect(states).toEqual(['downloading', 'downloading 41', 'preparing', 'ready'])
  })

  it('keeps a background preparation failure out of view', async () => {
    const updater = fakeUpdater()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available', { version: '0.1.2' })
    })
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.2',
      enabled: true,
    })
    await controller.check('background')
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.1.3' })
    })
    let fail!: (error: Error) => void
    updater.downloadUpdate.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)))

    await controller.check('background')
    updater.emit('download-progress', { percent: 100 })
    expect(controller.state()).toMatchObject({ status: 'preparing' })
    fail(new Error('The DMG app version does not match the release.'))
    await vi.waitFor(() => expect(controller.state()).toMatchObject({ status: 'current' }))
  })
})
