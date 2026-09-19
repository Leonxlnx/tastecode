import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appUpdateMode, createAppUpdateController } from './app-updater.js'

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
  it('installs updates for packaged Windows, macOS, and AppImage builds', () => {
    expect(appUpdateMode({ platform: 'linux', packaged: true })).toBe('manual')
    expect(appUpdateMode({ platform: 'linux', packaged: true, appImage: true })).toBe('install')
    expect(appUpdateMode({ platform: 'win32', packaged: true })).toBe('install')
    expect(appUpdateMode({ platform: 'darwin', packaged: true })).toBe('install')
    expect(appUpdateMode({ platform: 'freebsd', packaged: true })).toBe('unsupported')
    expect(appUpdateMode({ platform: 'linux', packaged: false })).toBe('unsupported')
    expect(
      appUpdateMode({
        platform: 'win32',
        packaged: true,
        developmentServer: 'http://127.0.0.1:5173',
      }),
    ).toBe('unsupported')
  })

  it('waits for updater cleanup on disposal', async () => {
    let finish!: () => void
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve
    })
    const updater = Object.assign(fakeUpdater(), { dispose: vi.fn(() => cleanup) })
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.7',
      mode: 'install',
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
      mode: 'install',
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

  it('keeps a downloaded update installable after a stray error', async () => {
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.1',
      mode: 'install',
    })

    updater.emit('update-available', info)
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce())
    updater.emit('update-downloaded', info)
    updater.emit('error', new Error('post-download signature probe failed'))

    expect(controller.state()).toMatchObject({ status: 'ready', version: info.version })
    expect(controller.install()).toBe(true)
  })

  it('does not replace a live download with an error state', () => {
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.1',
      mode: 'install',
    })

    updater.emit('update-available', info)
    updater.emit('download-progress', { percent: 40 })
    updater.emit('error', new Error('flaky network'))

    expect(controller.state()).toMatchObject({ status: 'downloading', progress: 40 })
  })

  it('does not leak a stale error field into download progress', () => {
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.1',
      mode: 'install',
    })

    updater.emit('error', new Error('check failed'))
    expect(controller.state()).toMatchObject({ status: 'error' })

    updater.emit('download-progress', { percent: 12 })
    expect(controller.state()).toEqual({
      status: 'downloading',
      currentVersion: '0.1.0-beta.1',
      progress: 12,
    })
  })

  it('stays inert outside a packaged build', async () => {
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.1',
      mode: 'unsupported',
    })

    await expect(controller.check()).resolves.toMatchObject({ status: 'unsupported' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.listenerCount('error')).toBe(0)
  })

  it('keeps packaged Linux updates manual without loading the updater', async () => {
    const loadUpdater = vi.fn()
    const controller = createAppUpdateController({
      loadUpdater,
      currentVersion: '0.1.0-beta.1',
      mode: 'manual',
    })

    controller.start()
    await expect(controller.check()).resolves.toEqual({
      status: 'manual',
      currentVersion: '0.1.0-beta.1',
    })
    expect(controller.install()).toBe(false)
    expect(loadUpdater).not.toHaveBeenCalled()
  })

  it('reports a newer published release for manual packages', async () => {
    const loadUpdater = vi.fn()
    const fetchLatest = vi.fn().mockResolvedValue({
      version: '0.1.0-beta.9',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
    })
    const controller = createAppUpdateController({
      loadUpdater,
      fetchLatest,
      currentVersion: '0.1.0-beta.8',
      mode: 'manual',
    })

    await expect(controller.check()).resolves.toEqual({
      status: 'manual',
      currentVersion: '0.1.0-beta.8',
      latestVersion: '0.1.0-beta.9',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
    })
    expect(controller.install()).toBe(false)
    expect(loadUpdater).not.toHaveBeenCalled()
  })

  it('signals a manual update when a stable release supersedes the running beta', async () => {
    const fetchLatest = vi.fn().mockResolvedValue({
      version: '0.1.0',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
    })
    const controller = createAppUpdateController({
      loadUpdater: vi.fn(),
      fetchLatest,
      currentVersion: '0.1.0-beta.9',
      mode: 'manual',
    })

    await expect(controller.check()).resolves.toEqual({
      status: 'manual',
      currentVersion: '0.1.0-beta.9',
      latestVersion: '0.1.0',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
    })
  })

  it('stays silent for manual packages when nothing newer is published', async () => {
    const fetchLatest = vi.fn().mockResolvedValue({
      version: '0.1.0-beta.8',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
    })
    const controller = createAppUpdateController({
      loadUpdater: vi.fn(),
      fetchLatest,
      currentVersion: '0.1.0-beta.8',
      mode: 'manual',
    })

    await expect(controller.check()).resolves.toEqual({
      status: 'manual',
      currentVersion: '0.1.0-beta.8',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
    })
  })

  it('drops a stale manual signal when the published release is no longer newer', async () => {
    const fetchLatest = vi
      .fn()
      .mockResolvedValueOnce({
        version: '0.1.0-beta.9',
        releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
      })
      .mockResolvedValueOnce({
        version: '0.1.0-beta.8',
        releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
      })
    const controller = createAppUpdateController({
      loadUpdater: vi.fn(),
      fetchLatest,
      currentVersion: '0.1.0-beta.8',
      mode: 'manual',
    })

    await expect(controller.check()).resolves.toMatchObject({ latestVersion: '0.1.0-beta.9' })
    await expect(controller.check()).resolves.toEqual({
      status: 'manual',
      currentVersion: '0.1.0-beta.8',
      releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
    })
  })

  it('keeps the last manual signal when a release check fails', async () => {
    const fetchLatest = vi
      .fn()
      .mockResolvedValueOnce({
        version: '0.1.0-beta.9',
        releasesUrl: 'https://github.com/Leonxlnx/tastecode/releases/latest',
      })
      .mockRejectedValueOnce(new Error('offline'))
    const controller = createAppUpdateController({
      loadUpdater: vi.fn(),
      fetchLatest,
      currentVersion: '0.1.0-beta.8',
      mode: 'manual',
    })

    await expect(controller.check()).resolves.toMatchObject({ latestVersion: '0.1.0-beta.9' })
    await expect(controller.check()).resolves.toMatchObject({
      status: 'manual',
      latestVersion: '0.1.0-beta.9',
    })
  })

  it('checks manual packages once after startup then every six hours', async () => {
    vi.useFakeTimers()
    const fetchLatest = vi.fn().mockResolvedValue(undefined)
    const controller = createAppUpdateController({
      loadUpdater: vi.fn(),
      fetchLatest,
      currentVersion: '0.1.0-beta.8',
      mode: 'manual',
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fetchLatest).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchLatest).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 1)
    expect(fetchLatest).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchLatest).toHaveBeenCalledTimes(2)
    controller.dispose()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetchLatest).toHaveBeenCalledTimes(2)
  })

  it('checks after startup and hourly while open, then stops on disposal', async () => {
    vi.useFakeTimers()
    const updater = fakeUpdater()
    const controller = createAppUpdateController({
      updater,
      currentVersion: '0.1.0-beta.1',
      mode: 'install',
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
      mode: 'install',
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
      mode: 'install',
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
      mode: 'install',
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
      mode: 'install',
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
      mode: 'install',
    })

    await expect(controller.check()).resolves.toMatchObject({ status: 'error' })
    await expect(controller.check()).resolves.toMatchObject({ status: 'error' })

    expect(loadUpdater).toHaveBeenCalledTimes(2)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  })
})
