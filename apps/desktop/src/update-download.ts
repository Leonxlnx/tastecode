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
    if (name !== path.basename(file))
      await rm(path.join(download.directory, name), { recursive: true, force: true })

  let offset = await sizeOf(file)
  if (offset > download.size) {
    await rm(file, { force: true })
    offset = 0
  }
  if (offset < download.size) await fetchRemainder(download, file, offset, true)
  const size = await sizeOf(file)
  // Bytes that arrived stay for the next attempt to continue from.
  if (size < download.size) throw new Error('The update download stopped before it finished.')
  if (size !== download.size || (await sha256Of(file)) !== download.sha256) {
    await rm(file, { force: true })
    throw new Error('The downloaded update does not match the GitHub file hash or size.')
  }
  return file
}

async function fetchRemainder(
  download: VerifiedDownload,
  file: string,
  offset: number,
  mayRestart: boolean,
): Promise<void> {
  const response = await download.fetch(download.url, {
    headers: {
      Accept: 'application/octet-stream',
      ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
    },
    signal: download.signal,
  })
  if (response.status === 416 && mayRestart) {
    // The stored bytes no longer fit this asset; start over once.
    await response.body?.cancel()
    await rm(file, { force: true })
    return fetchRemainder(download, file, 0, false)
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
      await rm(file, { force: true })
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
    { signal: download.signal },
  )
  report(true)
}
