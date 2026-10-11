import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { materializeAttachment, MAX_ATTACHMENT_BYTES } from './uploaded-attachment.js'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('remote attachment materialization', () => {
  it('writes decoded data under a private generated name', async () => {
    const directory = await temporaryDirectory()
    const target = await materializeAttachment(
      { name: '../references\\design notes.txt', data: Buffer.from('hello').toString('base64') },
      directory,
    )

    expect(path.dirname(target)).toBe(directory)
    expect(path.basename(target)).toMatch(/^[\da-f-]+-design notes\.txt$/)
    expect(readFileSync(target, 'utf8')).toBe('hello')
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('rejects malformed and oversized payloads', async () => {
    const directory = await temporaryDirectory()

    await expect(
      materializeAttachment({ name: 'bad.txt', data: 'not base64' }, directory),
    ).rejects.toThrow('valid base64')
    await expect(
      materializeAttachment(
        { name: 'large.bin', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') },
        directory,
      ),
    ).rejects.toThrow('25 MB')
  })

  it.skipIf(process.platform === 'win32')(
    'keeps the default directory per user instead of one shared temp name',
    async () => {
      const target = await materializeAttachment({
        name: 'image.png',
        data: Buffer.from('png').toString('base64'),
      })
      await rm(target)

      expect(path.dirname(target)).toBe(
        path.join(os.tmpdir(), `tastecode-attachments-${process.getuid!()}`),
      )
      expect(statSync(path.dirname(target)).mode & 0o777).toBe(0o700)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a directory another local user created or redirected first',
    async () => {
      // Another user could replace or delete the file before the agent reads it.
      const parent = await temporaryDirectory()
      const squatted = path.join(parent, 'squatted')
      mkdirSync(squatted)
      chmodSync(squatted, 0o777)
      vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
      const data = Buffer.from('hello').toString('base64')
      await expect(materializeAttachment({ name: 'a.txt', data }, squatted)).rejects.toThrow(
        'owned by another user',
      )
      vi.restoreAllMocks()

      const target = path.join(parent, 'target')
      const link = path.join(parent, 'link')
      mkdirSync(target)
      symlinkSync(target, link)
      await expect(materializeAttachment({ name: 'a.txt', data }, link)).rejects.toThrow(/symlink/)
      // A directory of the user's own that was left writable is tightened.
      await materializeAttachment({ name: 'a.txt', data }, squatted)
      expect(statSync(squatted).mode & 0o777).toBe(0o700)
    },
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-attachment-test-'))
  directories.push(directory)
  return directory
}
