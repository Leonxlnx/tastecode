import { writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { UpdateInfo } from 'electron-updater'
import { servePreparedUpdate, updateFileHashes, withUpdateDirectory } from './prepared-update.js'

const info: UpdateInfo = {
  version: '0.1.0-beta.8',
  releaseDate: '2026-09-20T00:00:00Z',
  files: [],
  path: '',
  sha512: '',
}

describe('prepared update transport', () => {
  it('serves exact bytes on a private loopback route with actual SHA-512 metadata', async () => {
    let oldUrl = ''
    let oldDirectory = ''
    await withUpdateDirectory(async (directory) => {
      oldDirectory = directory
      const file = path.join(directory, 'update.exe')
      const bytes = Buffer.from('verified installer bytes')
      await writeFile(file, bytes)
      expect(await updateFileHashes(file)).toEqual({
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sha512: createHash('sha512').update(bytes).digest('base64'),
      })
      await servePreparedUpdate(file, info, async (url, prepared) => {
        oldUrl = url
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        expect((await fetch(`${url}/`)).status).toBe(404)
        expect((await fetch(prepared.path, { method: 'POST' })).status).toBe(404)
        for (const origin of ['https://untrusted.example', 'null']) {
          expect((await fetch(prepared.path, { headers: { Origin: origin } })).status).toBe(404)
        }
        const response = await fetch(prepared.path)
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
        expect(prepared.files[0]!.sha512).toBe(createHash('sha512').update(bytes).digest('base64'))
      })
    })
    await expect(fetch(oldUrl)).rejects.toThrow()
    await expect(access(oldDirectory)).rejects.toThrow()
  })

  it('closes the server and removes temporary files when installation preparation fails', async () => {
    let oldDirectory = ''
    let oldUrl = ''
    await expect(
      withUpdateDirectory(async (directory) => {
        oldDirectory = directory
        const file = path.join(directory, 'update.zip')
        await writeFile(file, 'zip bytes')
        return servePreparedUpdate(file, info, async (url) => {
          oldUrl = url
          throw new Error('Native installer rejected the signature')
        })
      }),
    ).rejects.toThrow(/signature/)
    await expect(fetch(oldUrl)).rejects.toThrow()
    await expect(access(oldDirectory)).rejects.toThrow()
  })
})
