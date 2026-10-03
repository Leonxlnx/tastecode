import { rm } from 'node:fs/promises'
import path from 'node:path'
import electronUpdater, { type AppUpdater, type CancellationToken } from 'electron-updater'
import { getAppCacheDir } from 'electron-updater/out/AppAdapter.js'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js'
import {
  assetFromUpdateInfo,
  GitHubReleaseProvider,
  type ReleaseFetch,
} from './github-release-provider.js'
import { prepareDmgUpdate } from './dmg-update.js'
import { servePreparedUpdate, withUpdateDirectory } from './prepared-update.js'
import { downloadVerified } from './update-download.js'

export type ReleaseDownloads = {
  fetch: ReleaseFetch
  /** Where an interrupted download waits to be continued, across restarts. */
  directory: string
}

const activeDownloads = new WeakMap<
  AppUpdater,
  {
    token: CancellationToken
    finished: Promise<string[]>
  }
>()

export async function downloadRelease(
  updater: AppUpdater,
  options: DownloadUpdateOptions,
  install: (prepared: DownloadUpdateOptions) => Promise<string[]>,
  downloads: ReleaseDownloads,
) {
  const executor = new ElectronHttpExecutor((auth, callback) =>
    updater.emit('login', auth, callback),
  )
  const abort = new AbortController()
  const cancel = () => abort.abort()
  options.cancellationToken.on('cancel', cancel)
  if (options.cancellationToken.cancelled) cancel()
  const cancelled = () => new Error('Update download was cancelled.')
  const finished = withUpdateDirectory(async (directory) => {
    const info = options.updateInfoAndProvider.info
    const asset = assetFromUpdateInfo(info)
    const downloaded = await downloadVerified({
      url: asset.browser_download_url,
      size: asset.size,
      sha256: asset.digest.slice('sha256:'.length),
      extension: path.extname(asset.name),
      directory: downloads.directory,
      fetch: downloads.fetch,
      signal: abort.signal,
      onProgress: (progress) => updater.emit('download-progress', progress),
    }).catch((error: unknown) => {
      throw abort.signal.aborted ? cancelled() : error
    })
    // Every byte is here and verified, including when an earlier attempt had
    // already fetched them all. What follows is preparation, not download.
    updater.emit('download-progress', {
      total: asset.size,
      delta: 0,
      transferred: asset.size,
      percent: 100,
      bytesPerSecond: 0,
    })
    let handedOver = false
    try {
      const file = asset.name.endsWith('.dmg')
        ? await prepareDmgUpdate(downloaded, directory, info.version, abort.signal)
        : downloaded
      if (abort.signal.aborted) throw cancelled()
      const installed = await servePreparedUpdate(file, info, (url, prepared) =>
        install({
          ...options,
          disableDifferentialDownload: true,
          updateInfoAndProvider: {
            info: prepared,
            provider: new GenericProvider({ provider: 'generic', url }, updater, {
              executor,
              platform: asset.name.endsWith('.dmg') ? 'darwin' : 'win32',
              isUseMultipleRangeRequest: false,
            }),
          },
        }),
      )
      handedOver = true
      return installed
    } finally {
      // The native updater keeps its own copy, even when quitting raced its last
      // step. Quitting before then keeps the verified bytes for the next launch.
      // A Windows file lock must not turn a finished update into a failure.
      if (handedOver || !abort.signal.aborted)
        await rm(downloaded, { force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {})
    }
  }).finally(() => {
    activeDownloads.delete(updater)
    options.cancellationToken.removeListener('cancel', cancel)
  })
  activeDownloads.set(updater, { token: options.cancellationToken, finished })
  return finished
}

type ReleaseOptions = ConstructorParameters<typeof electronUpdater.MacUpdater>[0]

class DmgUpdater extends electronUpdater.MacUpdater {
  constructor(
    options: ReleaseOptions,
    private readonly downloads: ReleaseDownloads,
  ) {
    super(options)
  }

  protected override doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    return downloadRelease(
      this,
      options,
      (prepared) => super.doDownloadUpdate(prepared),
      this.downloads,
    )
  }
}

class ExeUpdater extends electronUpdater.NsisUpdater {
  constructor(
    options: ReleaseOptions,
    private readonly downloads: ReleaseDownloads,
  ) {
    super(options)
  }

  protected override doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    return downloadRelease(
      this,
      options,
      (prepared) => super.doDownloadUpdate(prepared),
      this.downloads,
    )
  }
}

export function createReleaseUpdater(release: {
  fetch: ReleaseFetch
}): AppUpdater & { dispose: () => Promise<void> } {
  // Installers are about 500 MB. An interrupted download waits in the machine's
  // cache (Library/Caches, or local AppData on Windows, never roaming AppData).
  const downloads = {
    fetch: release.fetch,
    directory: path.join(getAppCacheDir(), 'TasteCode', 'update-downloads'),
  }
  const options = {
    provider: 'custom' as const,
    updateProvider: GitHubReleaseProvider,
    fetch: release.fetch,
  }
  const updater =
    process.platform === 'darwin'
      ? new DmgUpdater(options, downloads)
      : process.platform === 'win32'
        ? new ExeUpdater(options, downloads)
        : undefined
  if (!updater) throw new Error('App updates are supported on Windows and macOS.')
  updater.disableDifferentialDownload = true
  updater.disableWebInstaller = true
  // Bytes of an update that is no longer needed, for example after a manual
  // install, would otherwise sit in the cache until the next release.
  updater.on('update-not-available', () => {
    void rm(downloads.directory, { recursive: true, force: true }).catch(() => {})
  })
  return Object.assign(updater, {
    dispose: async () => {
      const active = activeDownloads.get(updater)
      active?.token.cancel()
      await active?.finished.catch(() => {})
    },
  })
}
