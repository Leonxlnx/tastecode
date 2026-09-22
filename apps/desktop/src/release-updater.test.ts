import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppUpdater } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  prepare: vi.fn(),
  // The real updater classes pull in Electron's app adapter on construction;
  // the factory test only needs distinguishable bases.
  updaters: {
    AppImageUpdater: class {},
    MacUpdater: class {},
    NsisUpdater: class {},
  },
}))
vi.mock('electron-updater', () => ({ default: mocks.updaters }))
vi.mock('electron-updater/out/electronHttpExecutor.js', () => ({
  ElectronHttpExecutor: class {
    download = mocks.download
  },
}))
vi.mock('./dmg-update.js', () => ({ prepareDmgUpdate: mocks.prepare }))
import electronUpdater from 'electron-updater'
import { createReleaseUpdater, downloadRelease } from './release-updater.js'

const bytes = Buffer.from('trusted installer fixture')
let destination = ''
const assetNames = {
  exe: 'win-x64.exe',
  dmg: 'mac-arm64.dmg',
  AppImage: 'linux-x86_64.AppImage',
}
function options(extension: keyof typeof assetNames = 'exe'): DownloadUpdateOptions {
  const token = Object.assign(new EventEmitter(), { cancelled: false })
  return {
    updateInfoAndProvider: {
      info: {
        version: '0.1.0-beta.8',
        files: [],
        path: '',
        sha512: '',
        releaseDate: '2026-09-20T00:00:00Z',
        asset: {
          name: `TasteCode-0.1.0-beta.8-${assetNames[extension]}`,
          browser_download_url:
            'https://github.com/Leonxlnx/tastecode/releases/download/v0.1.0-beta.8/fixture',
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          size: bytes.length,
          state: 'uploaded',
        },
      },
      provider: {},
    },
    cancellationToken: token,
    requestHeaders: {},
    disableDifferentialDownload: false,
    disableWebInstaller: true,
  } as unknown as DownloadUpdateOptions
}
const updater = { emit: vi.fn() } as unknown as AppUpdater

beforeEach(() => {
  mocks.download.mockImplementation(async (_url, file) => {
    destination = file
    await writeFile(file, bytes)
  })
  mocks.prepare.mockImplementation(async (_dmg, directory) => {
    const zip = path.join(directory, 'update.zip')
    await writeFile(zip, 'prepared zip')
    return zip
  })
})
afterEach(() => vi.resetAllMocks())

describe('release download and installation', () => {
  it('verifies the EXE before handing exact bytes to the native installer', async () => {
    const install = vi.fn(async (prepared: DownloadUpdateOptions) => {
      const info = prepared.updateInfoAndProvider.info
      const file = prepared.updateInfoAndProvider.provider.resolveFiles(info)[0]!
      expect(Buffer.from(await (await fetch(file.url)).arrayBuffer())).toEqual(bytes)
      expect(file.info.sha512).toBe(createHash('sha512').update(bytes).digest('base64'))
      expect(prepared.disableDifferentialDownload).toBe(true)
      return ['native-cache/update.exe']
    })
    await expect(downloadRelease(updater, options(), install)).resolves.toEqual([
      'native-cache/update.exe',
    ])
    expect(mocks.download.mock.calls[0]![2].sha2).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    )
    expect(mocks.prepare).not.toHaveBeenCalled()
    await expect(access(destination)).rejects.toThrow()
  })

  it('serves a verified AppImage under its release name for in-place replacement', async () => {
    const install = vi.fn(async (prepared: DownloadUpdateOptions) => {
      const info = prepared.updateInfoAndProvider.info
      // AppImageUpdater.doInstall renames the download cache file next to the
      // replaced image, so the served route must carry the real asset name.
      expect(info.path).toMatch(/\/TasteCode-0\.1\.0-beta\.8-linux-x86_64\.AppImage$/)
      const provider = prepared.updateInfoAndProvider.provider
      const runtime = (provider as unknown as { runtimeOptions: { platform: string } })
        .runtimeOptions
      expect(runtime.platform).toBe('linux')
      const file = provider.resolveFiles(info)[0]!
      expect(file.url.pathname).toMatch(/\.AppImage$/)
      expect(Buffer.from(await (await fetch(file.url)).arrayBuffer())).toEqual(bytes)
      expect(file.info.sha512).toBe(createHash('sha512').update(bytes).digest('base64'))
      return ['update-cache/TasteCode-0.1.0-beta.8-linux-x86_64.AppImage']
    })
    await expect(downloadRelease(updater, options('AppImage'), install)).resolves.toEqual([
      'update-cache/TasteCode-0.1.0-beta.8-linux-x86_64.AppImage',
    ])
    expect(mocks.prepare).not.toHaveBeenCalled()
    await expect(access(destination)).rejects.toThrow()
  })

  it('turns a verified DMG into a local ZIP for the normal native installer', async () => {
    await downloadRelease(updater, options('dmg'), async (prepared) => {
      const info = prepared.updateInfoAndProvider.info
      expect(info.path).toMatch(/\.zip$/)
      expect(await (await fetch(info.path)).text()).toBe('prepared zip')
      return []
    })
    expect(mocks.prepare).toHaveBeenCalledWith(
      destination,
      path.dirname(destination),
      '0.1.0-beta.8',
      expect.any(AbortSignal),
    )
    await expect(access(destination)).rejects.toThrow()
  })

  it.each(['corrupt bytes', 'wrong size'])(
    'does not install %s and removes the failed download',
    async (kind) => {
      const input = options()
      if (kind === 'corrupt bytes')
        mocks.download.mockImplementation(async (_url, file) => {
          destination = file
          await writeFile(file, Buffer.alloc(bytes.length))
        })
      else
        Object.assign((input.updateInfoAndProvider.info as unknown as { asset: object }).asset, {
          size: bytes.length + 1,
        })
      const install = vi.fn()
      await expect(downloadRelease(updater, input, install)).rejects.toThrow(/hash or size/)
      expect(install).not.toHaveBeenCalled()
      expect(mocks.prepare).not.toHaveBeenCalled()
      await expect(access(destination)).rejects.toThrow()
    },
  )

  it('propagates a native signature rejection and cleans up', async () => {
    await expect(
      downloadRelease(updater, options(), async () => {
        throw new Error('Native signature mismatch')
      }),
    ).rejects.toThrow(/signature mismatch/)
    await expect(access(destination)).rejects.toThrow()
  })

  it('passes cancellation into DMG preparation and never installs after cancellation', async () => {
    const input = options('dmg')
    mocks.prepare.mockImplementation(async (_dmg, directory, _version, signal) => {
      input.cancellationToken.emit('cancel')
      expect(signal.aborted).toBe(true)
      return path.join(directory, 'update.zip')
    })
    const install = vi.fn()
    await expect(downloadRelease(updater, input, install)).rejects.toThrow(/cancelled/)
    expect(install).not.toHaveBeenCalled()
    expect(input.cancellationToken.listenerCount('cancel')).toBe(0)
    await expect(access(destination)).rejects.toThrow()
  })
})

describe('release updater selection', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const appImage = process.env.APPIMAGE

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    if (appImage === undefined) delete process.env.APPIMAGE
    else process.env.APPIMAGE = appImage
  })

  function onPlatform(value: string) {
    Object.defineProperty(process, 'platform', { ...platform, value })
  }

  it.each([
    ['darwin', mocks.updaters.MacUpdater],
    ['win32', mocks.updaters.NsisUpdater],
  ])('builds the native updater on %s', (value, base) => {
    onPlatform(value)
    const updater = createReleaseUpdater()
    expect(updater).toBeInstanceOf(base)
    expect(updater.disableDifferentialDownload).toBe(true)
    expect(updater.disableWebInstaller).toBe(true)
  })

  it('builds the AppImage updater on Linux inside an AppImage runtime', () => {
    onPlatform('linux')
    process.env.APPIMAGE = '/opt/TasteCode/TasteCode.AppImage'
    expect(createReleaseUpdater()).toBeInstanceOf(electronUpdater.AppImageUpdater)
  })

  it('stays fail-closed on Linux without a live AppImage runtime', () => {
    onPlatform('linux')
    delete process.env.APPIMAGE
    // The mode gate normally keeps deb installs off this path; if a caller
    // ever reaches the factory directly it must still refuse.
    expect(() => createReleaseUpdater()).toThrow(/AppImage/)
  })

  it('rejects platforms with no updater', () => {
    onPlatform('freebsd')
    expect(() => createReleaseUpdater()).toThrow(/supported/)
  })
})
