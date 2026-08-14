import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
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
  }) as unknown as AppUpdater
}

const info = { version: '0.1.0-beta.2' } as UpdateInfo

afterEach(() => vi.useRealTimers())

describe('app update controller', () => {
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
