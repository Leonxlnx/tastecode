import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppUpdater } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseFetch } from './github-release-provider.js'

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock('electron-updater/out/electronHttpExecutor.js', () => ({
  ElectronHttpExecutor: class {},
}))
vi.mock('./dmg-update.js', () => ({ prepareDmgUpdate: mocks.prepare }))
import { downloadRelease, type ReleaseDownloads } from './release-updater.js'

const bytes = Buffer.from('trusted installer fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')
let downloads: ReleaseDownloads
let fetchAsset: ReturnType<typeof vi.fn<ReleaseFetch>>
const stored = (extension: string) => path.join(downloads.directory, `${sha256}.${extension}`)

function options(extension = 'exe'): DownloadUpdateOptions {
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
          name: `TasteCode-0.1.0-beta.8-${extension === 'exe' ? 'win-x64.exe' : 'mac-arm64.dmg'}`,
          browser_download_url:
            'https://github.com/Leonxlnx/tastecode/releases/download/v0.1.0-beta.8/fixture',
          digest: `sha256:${sha256}`,
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

beforeEach(async () => {
  fetchAsset = vi.fn<ReleaseFetch>(async () => new Response(bytes))
  downloads = {
    fetch: fetchAsset,
    directory: await mkdtemp(path.join(os.tmpdir(), 'tastecode-release-')),
  }
  mocks.prepare.mockImplementation(async (_dmg, directory) => {
    const zip = path.join(directory, 'update.zip')
    await writeFile(zip, 'prepared zip')
    return zip
  })
})
afterEach(async () => {
  vi.resetAllMocks()
  await rm(downloads.directory, { recursive: true, force: true })
})

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
    await expect(downloadRelease(updater, options(), install, downloads)).resolves.toEqual([
      'native-cache/update.exe',
    ])
    expect(fetchAsset).toHaveBeenCalledWith(
      'https://github.com/Leonxlnx/tastecode/releases/download/v0.1.0-beta.8/fixture',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(updater.emit).toHaveBeenCalledWith(
      'download-progress',
      expect.objectContaining({ percent: 100 }),
    )
    expect(mocks.prepare).not.toHaveBeenCalled()
    // The native installer has its own copy now.
    expect(await readdir(downloads.directory)).toEqual([])
  })

  it('turns a verified DMG into a local ZIP for the normal native installer', async () => {
    await downloadRelease(
      updater,
      options('dmg'),
      async (prepared) => {
        const info = prepared.updateInfoAndProvider.info
        expect(info.path).toMatch(/\.zip$/)
        expect(await (await fetch(info.path)).text()).toBe('prepared zip')
        return []
      },
      downloads,
    )
    expect(mocks.prepare).toHaveBeenCalledWith(
      stored('dmg'),
      expect.any(String),
      '0.1.0-beta.8',
      expect.any(AbortSignal),
    )
    expect(await readdir(downloads.directory)).toEqual([])
  })

  it('does not install corrupt bytes and removes them', async () => {
    fetchAsset.mockImplementation(async () => new Response(Buffer.alloc(bytes.length)))
    const install = vi.fn()
    await expect(downloadRelease(updater, options(), install, downloads)).rejects.toThrow(
      /hash or size/,
    )
    expect(install).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    await expect(access(stored('exe'))).rejects.toThrow()
  })

  it('keeps a short download to continue later instead of installing it', async () => {
    const input = options()
    Object.assign((input.updateInfoAndProvider.info as unknown as { asset: object }).asset, {
      size: bytes.length + 1,
    })
    const install = vi.fn()
    await expect(downloadRelease(updater, input, install, downloads)).rejects.toThrow(
      /stopped before it finished/,
    )
    expect(install).not.toHaveBeenCalled()
    await expect(access(stored('exe'))).resolves.toBeUndefined()
  })

  it('propagates a native signature rejection and cleans up', async () => {
    await expect(
      downloadRelease(
        updater,
        options(),
        async () => {
          throw new Error('Native signature mismatch')
        },
        downloads,
      ),
    ).rejects.toThrow(/signature mismatch/)
    await expect(access(stored('exe'))).rejects.toThrow()
  })

  it('passes cancellation into DMG preparation and keeps the verified bytes', async () => {
    const input = options('dmg')
    mocks.prepare.mockImplementation(async (_dmg, directory, _version, signal) => {
      input.cancellationToken.emit('cancel')
      expect(signal.aborted).toBe(true)
      return path.join(directory, 'update.zip')
    })
    const install = vi.fn()
    await expect(downloadRelease(updater, input, install, downloads)).rejects.toThrow(/cancelled/)
    expect(install).not.toHaveBeenCalled()
    expect(input.cancellationToken.listenerCount('cancel')).toBe(0)
    // Quitting mid-update must not cost the next launch another full download.
    await expect(access(stored('dmg'))).resolves.toBeUndefined()
  })

  it('removes the bytes once the native updater has them, even if quitting raced it', async () => {
    const input = options()
    await downloadRelease(
      updater,
      input,
      async () => {
        input.cancellationToken.emit('cancel')
        return ['native-cache/update.exe']
      },
      downloads,
    )
    expect(await readdir(downloads.directory)).toEqual([])
  })

  it('reports a cancelled download as cancelled', async () => {
    const input = options()
    fetchAsset.mockImplementation(async (_url, init) => {
      input.cancellationToken.emit('cancel')
      throw init!.signal!.reason
    })
    await expect(downloadRelease(updater, input, vi.fn(), downloads)).rejects.toThrow(
      'Update download was cancelled.',
    )
  })
})
