import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeAttachment, MAX_ATTACHMENT_BYTES } from './uploaded-attachment.js'

const directories: string[] = []

afterEach(async () => {
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
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-attachment-test-'))
  directories.push(directory)
  return directory
}
