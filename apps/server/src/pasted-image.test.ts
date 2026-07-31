import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { savePastedImage } from './pasted-image.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('pasted image materialization', () => {
  it('writes a validated image to a private temporary path', async () => {
    const directory = await temporaryDirectory()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

    const saved = await savePastedImage(
      { mimeType: 'image/png', data: bytes.toString('base64') },
      directory,
    )

    expect(path.dirname(saved)).toBe(directory)
    expect(path.extname(saved)).toBe('.png')
    expect(await readFile(saved)).toEqual(bytes)
  })

  it('rejects bytes that do not match the declared image type', async () => {
    const directory = await temporaryDirectory()

    await expect(
      savePastedImage(
        { mimeType: 'image/png', data: Buffer.from('not an image').toString('base64') },
        directory,
      ),
    ).rejects.toThrow('Unsupported pasted image')
  })

  it('rejects malformed base64', async () => {
    const directory = await temporaryDirectory()

    await expect(
      savePastedImage({ mimeType: 'image/png', data: 'not-base64' }, directory),
    ).rejects.toThrow('Invalid pasted image data')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-pasted-image-test-'))
  directories.push(directory)
  return directory
}
