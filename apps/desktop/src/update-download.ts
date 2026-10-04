import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { ProgressInfo } from 'electron-updater'
import type { ReleaseFetch } from './github-release-provider.js'

const PROGRESS_INTERVAL = 250
// electron-updater's own downloader gave up after a minute without data too.
const STALL_TIMEOUT = 60_000

export type VerifiedDownload = {
  url: string
  size: number
  /** Lowercase hex SHA-256 that GitHub computed for the asset. */
  sha256: string
  extension: string
  /** Keeps one asset's bytes across attempts and app restarts. */
  directory: string
  fetch: ReleaseFetch
  signal: AbortSignal
  onProgress?: (progress: ProgressInfo) => void
  /** Gives up, keeping the bytes so far, when nothing arrives for this long. */
  stallTimeout?: number
}

// Windows virus scanners briefly lock a fresh installer. A file that cannot be
// removed yet is harmless: the next download or check removes it.
async function discard(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {})
}

async function sizeOf(file: string): Promise<number> {
  return stat(file).then(
    (info) => info.size,
    () => 0,
  )
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Downloads a release asset, continuing the bytes an interrupted attempt left
 * behind, and returns the file once its size and SHA-256 match GitHub's.
 */
export async function downloadVerified(download: VerifiedDownload): Promise<string> {
  const file = path.join(download.directory, `${download.sha256}${download.extension}`)
  await mkdir(download.directory, { recursive: true, mode: 0o700 })
  // Only one release is ever worth resuming: the one being downloaded now.
  for (const name of await readdir(download.directory))
    if (name !== path.basename(file)) await discard(path.join(download.directory, name))

  let offset = await sizeOf(file)
  if (offset > download.size) {
    await discard(file)
    offset = 0
  }
  if (offset < download.size && (await fetchRemainder(download, file, offset)) === 'restart') {
    // The stored bytes no longer fit this asset; start over once.
    await discard(file)
    await fetchRemainder(download, file, 0)
  }
  const size = await sizeOf(file)
  // Bytes that arrived stay for the next attempt to continue from.
  if (size < download.size) throw new Error('The update download stopped before it finished.')
  if (size !== download.size || (await sha256Of(file)) !== download.sha256) {
    await discard(file)
    throw new Error('The downloaded update does not match the GitHub file hash or size.')
  }
  return file
}

async function fetchRemainder(
  download: VerifiedDownload,
  file: string,
  offset: number,
): Promise<'done' | 'restart'> {
  // A connection that stays open but stops sending would otherwise hold the
  // update in "downloading" forever. Every arriving chunk resets the clock.
  const stall = new AbortController()
  const stallTimeout = download.stallTimeout ?? STALL_TIMEOUT
  let timer = setTimeout(() => stall.abort(), stallTimeout)
  const alive = () => {
    clearTimeout(timer)
    timer = setTimeout(() => stall.abort(), stallTimeout)
  }
  const signal = AbortSignal.any([download.signal, stall.signal])
  try {
    const response = await download.fetch(download.url, {
      headers: {
        Accept: 'application/octet-stream',
        ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
      },
      signal,
    })
    alive()
    if (response.status === 416 && offset > 0) {
      await response.body?.cancel()
      return 'restart'
    }
    const resumed = response.status === 206
    if ((response.status !== 200 && !resumed) || !response.body) {
      await response.body?.cancel()
      throw new Error(`GitHub answered the update download with HTTP ${response.status}.`)
    }
    if (resumed) {
      const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
      if (Number(range?.[1]) !== offset || Number(range?.[2]) !== download.size) {
        await response.body.cancel()
        await discard(file)
        throw new Error('GitHub resumed the update download at the wrong position.')
      }
    }
    // A server that ignores the range sends the whole file again.
    let transferred = resumed ? offset : 0
    const started = Date.now()
    let reportedAt = 0
    let unreported = 0
    const report = (force: boolean) => {
      const now = Date.now()
      if (!force && now - reportedAt < PROGRESS_INTERVAL) return
      const seconds = Math.max((now - started) / 1000, 0.001)
      download.onProgress?.({
        total: download.size,
        delta: unreported,
        transferred,
        percent: (transferred / download.size) * 100,
        bytesPerSecond: Math.round((transferred - (resumed ? offset : 0)) / seconds),
      })
      reportedAt = now
      unreported = 0
    }
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        alive()
        if (transferred + chunk.length > download.size) {
          callback(new Error('The update download is larger than GitHub announced.'))
          return
        }
        transferred += chunk.length
        unreported += chunk.length
        report(false)
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      counter,
      createWriteStream(file, { flags: resumed ? 'a' : 'w', mode: 0o600 }),
      { signal },
    )
    report(true)
    return 'done'
  } catch (error) {
    if (stall.signal.aborted && !download.signal.aborted)
      throw new Error('The update download stalled; the next attempt continues from here.', {
        cause: error,
      })
    throw error
  } finally {
    clearTimeout(timer)
  }
}
