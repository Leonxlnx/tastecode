import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDiagnostics } from './local-diagnostics.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true }))))

describe('local diagnostics', () => {
  it('stays off by default and scrubs sensitive error details when enabled', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    const onEnable = vi.fn()
    const diagnostics = new LocalDiagnostics(directory, onEnable)
    await diagnostics.initialize()

    await diagnostics.record(
      'renderer',
      new Error('C:\\Users\\Leon\\work lexn.lin@gmail.com token=secret'),
    )
    await expect(readFile(path.join(directory, 'errors.log'), 'utf8')).rejects.toThrow()

    await diagnostics.setEnabled(true)
    await diagnostics.record(
      'renderer',
      new Error('C:\\Users\\Leon\\work lexn.lin@gmail.com token=secret'),
    )
    const log = await readFile(path.join(directory, 'errors.log'), 'utf8')

    expect(onEnable).toHaveBeenCalledOnce()
    expect(log).toContain('[home]\\work [email] token=[redacted]')
    expect(log).not.toContain('Leon')
    expect(log).not.toContain('secret')
  })
})
