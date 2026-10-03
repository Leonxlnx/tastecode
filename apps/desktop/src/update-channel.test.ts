import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadUpdateChannel, saveUpdateChannel } from './update-channel.js'

let directory = ''

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('update channel preference', () => {
  it('starts on stable, then keeps a saved choice', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-channel-'))
    const file = path.join(directory, 'profile', 'update-channel.json')
    expect(loadUpdateChannel(file)).toBe('stable')

    saveUpdateChannel(file, 'beta')
    expect(loadUpdateChannel(file)).toBe('beta')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, channel: 'beta' })
  })

  it.each(['{"version":1,"channel":"nightly"}', '{"version":1}', 'null', 'not json'])(
    'falls back to stable for %s',
    async (contents) => {
      directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-channel-'))
      const file = path.join(directory, 'update-channel.json')
      await writeFile(file, contents)
      expect(loadUpdateChannel(file)).toBe('stable')
    },
  )
})
