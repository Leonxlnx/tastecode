import path from 'node:path'
import electronUpdater, {
  type AppUpdater,
  type CancellationToken,
  type ProgressInfo,
} from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js'
import { assetFromUpdateInfo, GitHubReleaseProvider } from './github-release-provider.js'
import { prepareDmgUpdate } from './dmg-update.js'
import { servePreparedUpdate, updateFileHashes, withUpdateDirectory } from './prepared-update.js'

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
) {
  const executor = new ElectronHttpExecutor((auth, callback) =>
    updater.emit('login', auth, callback),
  )
  const abort = new AbortController()
  const cancel = () => abort.abort()
  options.cancellationToken.on('cancel', cancel)
  if (options.cancellationToken.cancelled) cancel()
  const finished = withUpdateDirectory(async (directory) => {
    const info = options.updateInfoAndProvider.info
    const asset = assetFromUpdateInfo(info)
    const downloaded = path.join(directory, 'download' + path.extname(asset.name))
    await executor.download(new URL(asset.browser_download_url), downloaded, {
      sha2: asset.digest.slice('sha256:'.length),
      cancellationToken: options.cancellationToken,
      onProgress: (progress: ProgressInfo) => updater.emit('download-progress', progress),
    })
    const hash = await updateFileHashes(downloaded)
    if (hash.size !== asset.size || `sha256:${hash.sha256}` !== asset.digest)
      throw new Error('The downloaded update does not match the GitHub file hash or size.')
    const file = asset.name.endsWith('.dmg')
      ? await prepareDmgUpdate(downloaded, directory, info.version, abort.signal)
      : downloaded
    if (abort.signal.aborted) throw new Error('Update download was cancelled.')
    return servePreparedUpdate(
      file,
      info,
      (url, prepared) =>
        install({
          ...options,
          disableDifferentialDownload: true,
          updateInfoAndProvider: {
            info: prepared,
            provider: new GenericProvider({ provider: 'generic', url }, updater, {
              executor,
              platform: asset.name.endsWith('.dmg')
                ? 'darwin'
                : asset.name.endsWith('.AppImage')
                  ? 'linux'
                  : 'win32',
              isUseMultipleRangeRequest: false,
            }),
          },
        }),
      // AppImageUpdater keeps the downloaded file name when it replaces the
      // running image, so the versioned asset name must survive the local hop.
      asset.name.endsWith('.AppImage') ? asset.name : undefined,
    )
  }).finally(() => {
    activeDownloads.delete(updater)
    options.cancellationToken.removeListener('cancel', cancel)
  })
  activeDownloads.set(updater, { token: options.cancellationToken, finished })
  return finished
}

class DmgUpdater extends electronUpdater.MacUpdater {
  protected override doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    return downloadRelease(this, options, (prepared) => super.doDownloadUpdate(prepared))
  }
}

class ExeUpdater extends electronUpdater.NsisUpdater {
  protected override doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    return downloadRelease(this, options, (prepared) => super.doDownloadUpdate(prepared))
  }
}

class AppImageUpdater extends electronUpdater.AppImageUpdater {
  protected override doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    return downloadRelease(this, options, (prepared) => super.doDownloadUpdate(prepared))
  }
}

export function createReleaseUpdater(): AppUpdater & { dispose: () => Promise<void> } {
  const options = { provider: 'custom' as const, updateProvider: GitHubReleaseProvider }
  const updater =
    process.platform === 'darwin'
      ? new DmgUpdater(options)
      : process.platform === 'win32'
        ? new ExeUpdater(options)
        : // The AppImage runtime exports APPIMAGE with the mounted image path;
          // the mode gate stays ahead of this, so reaching it unset means a deb
          // or unpackaged build slipped through — stay fail-closed.
          process.platform === 'linux' && process.env.APPIMAGE !== undefined
          ? new AppImageUpdater(options)
          : undefined
  if (!updater)
    throw new Error('App updates are supported on Windows, macOS, and Linux AppImage installs.')
  updater.disableDifferentialDownload = true
  updater.disableWebInstaller = true
  return Object.assign(updater, {
    dispose: async () => {
      const active = activeDownloads.get(updater)
      active?.token.cancel()
      await active?.finished.catch(() => {})
    },
  })
}
