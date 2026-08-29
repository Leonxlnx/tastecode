import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appOwnsUpdates, createAppUpdateController } from './app-updater.js'

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
  it('allows app-owned updates only for packaged AppImage, Windows, and macOS builds', () => {
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/tmp/TasteCode.AppImage',
      }),
    ).toBe(true)
    expect(appOwnsUpdates({ platform: 'linux', packaged: true })).toBe(false)
    expect(appOwnsUpdates({ platform: 'win32', packaged: true })).toBe(true)
    expect(appOwnsUpdates({ platform: 'darwin', packaged: true })).toBe(true)
    expect(appOwnsUpdates({ platform: 'linux', packaged: false, appImagePath: '/tmp/app' })).toBe(
      false,
    )
    expect(
      appOwnsUpdates({
        platform: 'win32',
        packaged: true,
        developmentServer: 'http://localhost:5173',
      }),
    ).toBe(false)
  })

  it('disables updates for unpacked Linux with the main-process option shape', () => {
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        developmentServer: undefined,
        appImagePath: undefined,
      }),
    ).toBe(false)
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
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.listenerCount('error')).toBe(0)
  })

  it('checks automatically after startup', async () => {
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
  })
})
