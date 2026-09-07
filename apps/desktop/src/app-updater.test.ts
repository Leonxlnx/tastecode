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
        appDirPath: '/tmp/.mount_TasteCoABC123',
        executablePath: '/tmp/.mount_TasteCoABC123/tastecode',
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

  it('owns updates when the executable is inside its own AppImage mount', () => {
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/opt/TasteCode.AppImage',
        appDirPath: '/tmp/.mount_TasteCoABC123',
        executablePath: '/tmp/.mount_TasteCoABC123/tastecode',
      }),
    ).toBe(true)
  })

  it('refuses updates when APPIMAGE is inherited but the executable is unpacked', () => {
    // Child unpacked binary keeps T3's APPIMAGE but runs outside T3's APPDIR.
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/opt/T3-Code.AppImage',
        appDirPath: '/tmp/.mount_T3CodeXYZ999',
        executablePath: '/home/user/taste-code/release/linux-unpacked/tastecode',
      }),
    ).toBe(false)
  })

  it('refuses Linux updates without both APPIMAGE and its own APPDIR proof', () => {
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/opt/TasteCode.AppImage',
      }),
    ).toBe(false)
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appDirPath: '/tmp/.mount_TasteCoABC123',
        executablePath: '/tmp/.mount_TasteCoABC123/tastecode',
      }),
    ).toBe(false)
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/opt/TasteCode.AppImage',
        appDirPath: '/tmp/.mount_TasteCoABC123',
      }),
    ).toBe(false)
  })

  it('refuses Linux updates on a sibling-prefix path trick', () => {
    // String prefix is not containment.
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/opt/TasteCode.AppImage',
        appDirPath: '/tmp/.mount_TasteCode',
        executablePath: '/tmp/.mount_TasteCode-evil/tastecode',
      }),
    ).toBe(false)
  })

  it('owns updates for a nested executable inside its own AppImage mount', () => {
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/opt/TasteCode.AppImage',
        appDirPath: '/tmp/.mount_TasteCoABC123',
        executablePath: '/tmp/.mount_TasteCoABC123/usr/bin/tastecode',
      }),
    ).toBe(true)
  })

  it('refuses Linux updates on traversal and equality tricks', () => {
    // `..` escapes the mount even though the string contains the APPDIR prefix.
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/opt/TasteCode.AppImage',
        appDirPath: '/tmp/.mount_TasteCoABC123',
        executablePath: '/tmp/.mount_TasteCoABC123/../evil/tastecode',
      }),
    ).toBe(false)
    // The mount directory itself is not an executable inside it.
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/opt/TasteCode.AppImage',
        appDirPath: '/tmp/.mount_TasteCoABC123',
        executablePath: '/tmp/.mount_TasteCoABC123',
      }),
    ).toBe(false)
  })

  it('refuses Linux updates for a relative or extracted APPIMAGE', () => {
    // A relative APPIMAGE proves nothing about the running mount.
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: 'TasteCode.AppImage',
        appDirPath: '/tmp/.mount_TasteCoABC123',
        executablePath: '/tmp/.mount_TasteCoABC123/tastecode',
      }),
    ).toBe(false)
    // An extracted squashfs-root keeps the image inside APPDIR, unlike a
    // real Type-2 mount where the image file lives outside it.
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/tmp/squashfs-root/TasteCode.AppImage',
        appDirPath: '/tmp/squashfs-root',
        executablePath: '/tmp/squashfs-root/tastecode',
      }),
    ).toBe(false)
    expect(
      appOwnsUpdates({
        platform: 'linux',
        packaged: true,
        appImagePath: '/tmp/squashfs-root',
        appDirPath: '/tmp/squashfs-root',
        executablePath: '/tmp/squashfs-root/tastecode',
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
})
