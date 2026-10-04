import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadVerified, type VerifiedDownload } from './update-download.js'

// chmod does not enforce directory permissions on Windows; inject the filesystem errors.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const bytes = randomBytes(256 * 1024)
const sha256 = createHash('sha256').update(bytes).digest('hex')
let server: Server
let url = ''
let directory = ''
let requests: Array<{ range: string | undefined }> = []
let behavior:
  | 'ranges'
  | 'ignore-ranges'
  | 'refuse-ranges'
  | 'stall'
  | 'silent'
  | 'drop'
  | 'error'
  | 'no-content-range'
  | 'redirect' = 'ranges'

function send(request: IncomingMessage, response: import('node:http').ServerResponse) {
  if (behavior === 'redirect' && !request.url?.startsWith('/cdn/')) {
    // GitHub answers release downloads with a redirect to its storage host.
    response.writeHead(302, { Location: `/cdn${request.url}` }).end()
    return
  }
  requests.push({ range: request.headers.range })
  if (behavior === 'silent') return
  if (behavior === 'error') {
    response.writeHead(500).end()
    return
  }
  if (behavior === 'drop') {
    // The connection closes halfway through the promised length.
    response.writeHead(200, { 'Content-Length': bytes.length })
    response.write(bytes.subarray(0, bytes.length / 2), () => response.socket?.end())
    return
  }
  if (behavior === 'no-content-range' && request.headers.range) {
    response.writeHead(206).end(bytes.subarray(100_000))
    return
  }
  const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
  if (range && behavior === 'refuse-ranges') {
    response.writeHead(416).end()
    return
  }
  if (range && (behavior === 'ranges' || behavior === 'redirect')) {
    const start = Number(range[1])
    response.writeHead(206, {
      'Content-Length': bytes.length - start,
      'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
    })
    response.end(bytes.subarray(start))
    return
  }
  response.writeHead(200, { 'Content-Length': bytes.length })
  if (behavior === 'stall') {
    // Half the asset, then the connection stays open until the client gives up.
    response.write(bytes.subarray(0, bytes.length / 2))
    return
  }
  response.end(bytes)
}

beforeEach(async () => {
  requests = []
  behavior = 'ranges'
  directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-download-'))
  server = createServer(send)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/TasteCode-0.1.3-mac-arm64.dmg`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
})

function options(change: Partial<VerifiedDownload> = {}): VerifiedDownload {
  return {
    url,
    size: bytes.length,
    sha256,
    extension: '.dmg',
    directory,
    fetch: (input, init) => fetch(input, init),
    signal: new AbortController().signal,
    ...change,
  }
}

const stored = () => path.join(directory, `${sha256}.dmg`)

describe('resumable update downloads', () => {
  it('downloads and verifies a fresh asset with whole-file progress', async () => {
    const onProgress = vi.fn()
    const file = await downloadVerified(options({ onProgress }))

    expect(file).toBe(stored())
    expect(await readFile(file)).toEqual(bytes)
    expect(requests).toEqual([{ range: undefined }])
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ total: bytes.length, transferred: bytes.length, percent: 100 }),
    )
  })

  it('continues from the bytes an interrupted attempt left behind', async () => {
    await writeFile(stored(), bytes.subarray(0, 100_000))
    const onProgress = vi.fn()

    expect(await readFile(await downloadVerified(options({ onProgress })))).toEqual(bytes)
    expect(requests).toEqual([{ range: 'bytes=100000-' }])
    const first = onProgress.mock.calls[0]![0]
    expect(first.transferred).toBeGreaterThan(100_000)
  })

  it('starts over when the server ignores the range', async () => {
    behavior = 'ignore-ranges'
    await writeFile(stored(), bytes.subarray(0, 100_000))

    expect(await readFile(await downloadVerified(options()))).toEqual(bytes)
    expect(requests).toEqual([{ range: 'bytes=100000-' }])
  })

  it('starts over once when the stored bytes no longer fit the asset', async () => {
    behavior = 'refuse-ranges'
    await writeFile(stored(), bytes.subarray(0, 100_000))

    expect(await readFile(await downloadVerified(options()))).toEqual(bytes)
    expect(requests).toEqual([{ range: 'bytes=100000-' }, { range: undefined }])
  })

  it('needs no request when a complete download is already stored', async () => {
    await writeFile(stored(), bytes)
    expect(await downloadVerified(options())).toBe(stored())
    expect(requests).toEqual([])
  })

  it('discards corrupt bytes so the next attempt starts clean', async () => {
    const corrupt = Buffer.from(bytes)
    corrupt[10] = corrupt[10]! ^ 0xff
    await writeFile(stored(), corrupt.subarray(0, 100_000))

    await expect(downloadVerified(options())).rejects.toThrow(/hash or size/)
    await expect(stat(stored())).rejects.toThrow()
    expect(await readFile(await downloadVerified(options()))).toEqual(bytes)
  })

  it('keeps what arrived before a cancellation for the next attempt', async () => {
    behavior = 'stall'
    const abort = new AbortController()
    const attempt = downloadVerified(options({ signal: abort.signal }))
    // Cancel once the half the server sent is on disk, as quitting mid-download would.
    await vi.waitFor(async () => expect((await stat(stored())).size).toBe(bytes.length / 2))
    abort.abort()
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' })

    behavior = 'ranges'
    requests = []
    expect(await readFile(await downloadVerified(options()))).toEqual(bytes)
    expect(requests).toEqual([{ range: `bytes=${bytes.length / 2}-` }])
  })

  it('gives up on a stalled connection and continues from its bytes next time', async () => {
    behavior = 'stall'
    await expect(downloadVerified(options({ stallTimeout: 300 }))).rejects.toThrow(/stalled/)
    expect((await stat(stored())).size).toBe(bytes.length / 2)

    behavior = 'ranges'
    requests = []
    expect(await readFile(await downloadVerified(options()))).toEqual(bytes)
    expect(requests).toEqual([{ range: `bytes=${bytes.length / 2}-` }])
  })

  it('gives up when the server accepts the connection but never answers', async () => {
    behavior = 'silent'
    await expect(downloadVerified(options({ stallTimeout: 300 }))).rejects.toThrow(/stalled/)
  })

  it('keeps only the asset being downloaded', async () => {
    await writeFile(path.join(directory, `${'0'.repeat(64)}.dmg`), 'older release')
    await downloadVerified(options())
    expect(await readdir(directory)).toEqual([`${sha256}.dmg`])
  })

  it('downloads even when a leftover from an older release cannot be removed yet', async () => {
    const locked = path.join(directory, 'locked')
    await mkdir(locked)
    await writeFile(path.join(locked, 'older.dmg'), 'older release')
    const busy = Object.assign(new Error('The older release is locked'), { code: 'EBUSY' })
    const { rm: originalRm } = await vi.importActual<typeof fsPromises>('node:fs/promises')
    const removal = vi.spyOn(fsPromises, 'rm').mockImplementation(async (target, settings) => {
      if (target === locked) throw busy
      return originalRm(target, settings)
    })
    try {
      expect(await readFile(await downloadVerified(options()))).toEqual(bytes)
      expect(removal).toHaveBeenCalledWith(locked, expect.any(Object))
      expect(await readFile(path.join(locked, 'older.dmg'), 'utf8')).toBe('older release')
    } finally {
      removal.mockRestore()
    }
  })

  it('keeps the bytes of a dropped connection and continues from them', async () => {
    behavior = 'drop'
    await expect(downloadVerified(options())).rejects.toThrow()
    // Whatever reached the disk stays; how much depends on write timing.
    const kept = await stat(stored()).then(
      (file) => file.size,
      () => 0,
    )
    expect(kept).toBeLessThan(bytes.length)

    behavior = 'ranges'
    requests = []
    expect(await readFile(await downloadVerified(options()))).toEqual(bytes)
    expect(requests).toEqual([{ range: kept > 0 ? `bytes=${kept}-` : undefined }])
  })

  it('reports a server error and leaves earlier bytes alone', async () => {
    await writeFile(stored(), bytes.subarray(0, 100_000))
    behavior = 'error'
    await expect(downloadVerified(options())).rejects.toThrow('HTTP 500')
    expect((await stat(stored())).size).toBe(100_000)
  })

  it('discards stored bytes when a resumed answer does not say where it starts', async () => {
    await writeFile(stored(), bytes.subarray(0, 100_000))
    behavior = 'no-content-range'
    await expect(downloadVerified(options())).rejects.toThrow(/wrong position/)
    await expect(stat(stored())).rejects.toThrow()
  })

  it('keeps the range when GitHub redirects to its storage host', async () => {
    behavior = 'redirect'
    await writeFile(stored(), bytes.subarray(0, 100_000))
    expect(await readFile(await downloadVerified(options()))).toEqual(bytes)
    expect(requests).toEqual([{ range: 'bytes=100000-' }])
  })

  it('starts over when more bytes are stored than the asset has', async () => {
    await writeFile(stored(), Buffer.concat([bytes, Buffer.from('extra')]))
    expect(await readFile(await downloadVerified(options()))).toEqual(bytes)
    expect(requests).toEqual([{ range: undefined }])
  })

  it('creates a missing download folder', async () => {
    const nested = path.join(directory, 'Caches', 'TasteCode', 'update-downloads')
    const file = await downloadVerified(options({ directory: nested }))
    expect(path.dirname(file)).toBe(nested)
  })

  it('fails cleanly when the download folder cannot be written', async () => {
    const actualFs = await vi.importActual<typeof fs>('node:fs')
    const denied = Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    const writer = vi.spyOn(fs, 'createWriteStream').mockImplementation((file, settings) => {
      if (file !== stored()) return actualFs.createWriteStream(file, settings)
      const streamSettings: fs.WriteStreamOptions | undefined =
        typeof settings === 'string' ? { encoding: settings } : settings
      return actualFs.createWriteStream(file, {
        ...streamSettings,
        fs: {
          ...actualFs,
          ...streamSettings?.fs,
          open: (_file, _flags, _mode, callback) => callback(denied),
        },
      })
    })
    try {
      await expect(downloadVerified(options())).rejects.toBe(denied)
      expect(writer).toHaveBeenCalledWith(stored(), expect.any(Object))
      await expect(stat(stored())).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      writer.mockRestore()
    }
  })

  it('reports steadily rising progress that ends at exactly 100 percent', async () => {
    const reports: number[] = []
    await downloadVerified(options({ onProgress: (progress) => reports.push(progress.percent) }))
    expect(reports.at(-1)).toBe(100)
    expect(reports).toEqual([...reports].sort((a, b) => a - b))
    expect(Math.max(...reports)).toBe(100)
  })

  it('rejects a body larger than GitHub announced', async () => {
    await expect(downloadVerified(options({ size: bytes.length - 1 }))).rejects.toThrow(/larger/)
  })
})
