import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_PASTED_FILE_BYTES, pastedFile, savePastedFile } from './pasted-file.js'

describe('pastedFile', () => {
  it('stores unique attachments under durable app data without pruning older files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-paste-'))
    try {
      const data = path.join(root, 'app-data')
      const payload = { name: 'note.txt', type: 'text/plain', bytes: Buffer.from('retained') }
      const first = await savePastedFile(data, payload)
      const second = await savePastedFile(data, payload)
      expect(path.dirname(first)).toBe(path.join(data, 'pasted-files'))
      expect(second).not.toBe(first)
      expect(await readFile(first, 'utf8')).toBe('retained')
      expect(await readFile(second, 'utf8')).toBe('retained')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('materializes ordinary files with a safe leaf name', () => {
    const file = pastedFile({
      name: '..\\..\\report?.pdf',
      type: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF-1.7'),
    })

    expect(file.name).toBe('report-.pdf')
    expect(file.bytes.toString()).toBe('%PDF-1.7')
  })

  it('keeps the media extension when a long name is shortened', () => {
    const bytes = new Uint8Array([0, 0, 0, 24])
    const ascii = pastedFile({ name: `${'a'.repeat(200)}.mp4`, type: 'video/mp4', bytes })
    expect(ascii.name).toMatch(/^a+\.mp4$/)
    expect(Buffer.byteLength(ascii.name)).toBeLessThanOrEqual(160)

    const wide = pastedFile({ name: `${'é'.repeat(120)}.webm`, type: 'video/webm', bytes })
    expect(wide.name.endsWith('.webm')).toBe(true)
    expect(Buffer.byteLength(wide.name)).toBeLessThanOrEqual(160)
    expect(wide.name).not.toContain('\uFFFD')

    expect(pastedFile({ name: '.mp4', type: 'video/mp4', bytes }).name).toBe('mp4')
  })

  it('keeps image magic-byte validation', () => {
    expect(() =>
      pastedFile({ name: 'fake.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3]) }),
    ).toThrow('Unsupported pasted image')
  })

  it('accepts the AVIF and icon images the picker previews', () => {
    const avif = Buffer.concat([
      Buffer.from([0, 0, 0, 0x1c]),
      Buffer.from('ftypmif1\0\0\0\0mif1avifmiaf'),
    ])
    expect(pastedFile({ name: 'photo.avif', type: 'image/avif', bytes: avif }).name).toBe(
      'pasted-image.avif',
    )
    expect(
      pastedFile({ name: 'icon.ico', type: 'image/x-icon', bytes: new Uint8Array([0, 0, 1, 0, 1]) })
        .name,
    ).toBe('pasted-image.ico')
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0heic')])
    expect(() => pastedFile({ name: 'photo.avif', type: 'image/avif', bytes: heic })).toThrow(
      'Unsupported pasted image',
    )
  })

  it('rejects files above the bounded clipboard bridge limit', () => {
    expect(() =>
      pastedFile({
        name: 'movie.mp4',
        type: 'video/mp4',
        bytes: new Uint8Array(MAX_PASTED_FILE_BYTES + 1),
      }),
    ).toThrow('larger than 25 MB')
  })
})
