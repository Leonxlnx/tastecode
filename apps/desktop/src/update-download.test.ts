import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadVerified, type VerifiedDownload } from './update-download.js'

const bytes = randomBytes(256 * 1024)
const sha256 = createHash('sha256').update(bytes).digest('hex')
let server: Server
let url = ''
let directory = ''
let requests: Array<{ range: string | undefined }> = []
let behavior: 'ranges' | 'ignore-ranges' | 'refuse-ranges' | 'stall' | 'silent' = 'ranges'

function send(request: IncomingMessage, response: import('node:http').ServerResponse) {
  requests.push({ range: request.headers.range })
  if (behavior === 'silent') return
  const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
  if (range && behavior === 'refuse-ranges') {
    response.writeHead(416).end()
    return
  }
  if (range && behavior === 'ranges') {
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

  it('rejects a body larger than GitHub announced', async () => {
    await expect(downloadVerified(options({ size: bytes.length - 1 }))).rejects.toThrow(/larger/)
  })
})
