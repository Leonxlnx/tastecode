import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { get, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startStaticDesignPreview } from './design-static-preview.js'

const roots: string[] = []
const previews: Awaited<ReturnType<typeof startStaticDesignPreview>>[] = []
afterEach(async () => {
  await Promise.all(previews.splice(0).map((preview) => preview.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function preview() {
  const root = mkdtempSync(path.join(tmpdir(), 'taste-static-media-'))
  roots.push(root)
  writeFileSync(
    path.join(root, 'index.html'),
    '<video src="clip.mp4"></video><audio src="song.mp3"></audio><a href="guide.pdf">Guide</a>',
  )
  for (const file of [
    'clip.mp4',
    'song.mp3',
    'guide.pdf',
    'clip.webm',
    'clip.mov',
    'clip.ogv',
    'song.wav',
    'song.ogg',
    'song.m4a',
  ]) {
    writeFileSync(path.join(root, file), '0123456789')
  }
  const running = await startStaticDesignPreview(root, {
    version: 1,
    kind: 'static',
    cwd: '.',
    entry: 'index.html',
    url: 'http://127.0.0.1:0/',
    viewports: [
      { name: 'desktop', width: 1440, height: 1000 },
      { name: 'mobile', width: 390, height: 844 },
    ],
  })
  previews.push(running)
  return { root, url: running.url }
}

describe('static Design media preview', () => {
  it('reports an entry page over the markup limit as too large', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'taste-static-large-'))
    roots.push(root)
    writeFileSync(path.join(root, 'index.html'), `<h1>Large</h1>${' '.repeat(2 * 1024 * 1024)}`)
    await expect(
      startStaticDesignPreview(root, {
        version: 1,
        kind: 'static',
        cwd: '.',
        entry: 'index.html',
        url: 'http://127.0.0.1:0/',
        viewports: [{ name: 'desktop', width: 1440, height: 1000 }],
      }),
    ).rejects.toThrow('static preview HTML is too large')
  })

  it('starts with local media and serves video, audio and PDF MIME types', async () => {
    const { url } = await preview()
    for (const [file, type] of [
      ['clip.mp4', 'video/mp4'],
      ['clip.webm', 'video/webm'],
      ['clip.mov', 'video/quicktime'],
      ['clip.ogv', 'video/ogg'],
      ['song.mp3', 'audio/mpeg'],
      ['song.wav', 'audio/wav'],
      ['song.ogg', 'audio/ogg'],
      ['song.m4a', 'audio/mp4'],
      ['guide.pdf', 'application/pdf'],
    ]) {
      const response = await fetch(new URL(file!, url))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(type)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await response.text()).toBe('0123456789')
    }
  })

  it('serves bounded, open-ended and suffix byte ranges without reading the whole video', async () => {
    const { url } = await preview()
    for (const [range, body, contentRange] of [
      ['bytes=2-5', '2345', 'bytes 2-5/10'],
      ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'],
      ['bytes=8-100', '89', 'bytes 8-9/10'],
      ['bytes=-100', '0123456789', 'bytes 0-9/10'],
    ]) {
      const response = await fetch(new URL('clip.mp4', url), { headers: { range: range! } })
      expect(response.status).toBe(206)
      expect(response.headers.get('accept-ranges')).toBe('bytes')
      expect(response.headers.get('content-range')).toBe(contentRange)
      expect(response.headers.get('content-length')).toBe(String(body!.length))
      expect(await response.text()).toBe(body)
    }
  })

  it('rejects invalid ranges and honors HEAD without a response body', async () => {
    const { root, url } = await preview()
    for (const range of [
      'bytes=10-',
      'bytes=8-2',
      'bytes=-0',
      'bytes=-',
      'bytes=0-1,4-5',
      'bytes=9007199254740992-',
    ]) {
      const response = await fetch(new URL('clip.mp4', url), { headers: { range } })
      expect(response.status).toBe(416)
      expect(response.headers.get('content-range')).toBe('bytes */10')
      await response.text()
    }
    const head = await fetch(new URL('clip.mp4', url), {
      method: 'HEAD',
      headers: { range: 'bytes=2-4' },
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
    writeFileSync(path.join(root, 'empty.mp4'), '')
    const empty = await fetch(new URL('empty.mp4', url))
    expect(empty.status).toBe(200)
    expect(await empty.text()).toBe('')
    const unsupported = await fetch(new URL('private.txt', url))
    expect(unsupported.status).toBe(404)
    await unsupported.text()
  })

  it('refuses another site that reaches the preview by rebinding its name or cross-origin', async () => {
    const { url } = await preview()
    const status = (headers: Record<string, string>) =>
      new Promise<number | undefined>((resolve, reject) =>
        get(new URL('index.html', url), { headers }, (response) => {
          response.resume()
          resolve(response.statusCode)
        }).once('error', reject),
      )
    const { host, origin, port } = new URL(url)
    expect(await status({ host: `attacker.example:${port}` })).toBe(403)
    expect(await status({ host: `localhost:${port}` })).toBe(403)
    expect(await status({ host, origin: 'http://attacker.example' })).toBe(403)
    expect(await status({ host, origin: 'http://127.0.0.1:5183' })).toBe(403)
    expect(await status({ host })).toBe(200)
    expect(await status({ host, origin })).toBe(200)
  })

  it('stops while a client holds a media response open', async () => {
    const { root, url } = await preview()
    // Large enough that the socket buffers fill and the response keeps streaming.
    writeFileSync(path.join(root, 'hero.mp4'), Buffer.alloc(32 * 1024 * 1024))
    const response = await new Promise<IncomingMessage>((resolve, reject) =>
      get(new URL('hero.mp4', url), resolve).once('error', reject),
    )
    // Chromium stops reading a buffered video and keeps the connection open.
    await new Promise((resolve) => response.once('data', resolve))
    response.pause()
    response.on('error', () => undefined)
    const running = previews.pop()!
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      running.stop().then(() => 'stopped'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('still waiting'), 2_000)
      }),
    ])
    clearTimeout(timer)
    response.destroy()
    expect(outcome).toBe('stopped')
  })

  it('keeps serving only the folder it started on after that folder is swapped for a link', async () => {
    const { root, url } = await preview()
    const parent = mkdtempSync(path.join(tmpdir(), 'taste-static-swap-'))
    roots.push(parent)
    const outside = path.join(parent, '.aws', 'sso')
    mkdirSync(path.join(outside, 'cache'), { recursive: true })
    writeFileSync(path.join(outside, 'cache', 'token.json'), '{"accessToken":"synthetic"}')
    writeFileSync(path.join(outside, 'cache', 'clip.mp4'), 'outside')
    renameSync(root, `${root}-moved`)
    roots.push(`${root}-moved`)
    symlinkSync(outside, root, 'junction')

    for (const file of ['cache/token.json', 'cache/clip.mp4']) {
      const response = await fetch(new URL(file, url))
      expect(response.status).toBe(404)
      await response.text()
    }
  })
})
