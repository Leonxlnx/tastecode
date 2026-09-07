import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDiagnostics, scrub } from './local-diagnostics.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true }))))

const fakeSecrets = {
  openAI: ['sk', 'proj', 'A'.repeat(32)].join('-'),
  anthropic: ['sk', 'ant', 'api03', 'B'.repeat(32)].join('-'),
  github: `ghp_${'C'.repeat(36)}`,
  slack: ['xoxb', '1234567890', 'D'.repeat(24)].join('-'),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmaXh0dXJlIn0', 'E'.repeat(24)].join('.'),
  privateKey: [
    '-----BEGIN PRIVATE KEY-----',
    'RklYVFVSRS1OT1QtQS1LRVk=',
    '-----END PRIVATE KEY-----',
  ].join('\n'),
}

describe('local diagnostics', () => {
  it('scrubs Windows, macOS, and Linux home directories', () => {
    expect(scrub('C:\\Users\\Leon Lin\\work /Users/Leon Lin/work /home/leon/work')).toBe(
      '[home]\\work [home]/work [home]/work',
    )
  })

  it('scrubs standalone secret shapes while preserving surrounding context', () => {
    const message = `before ${Object.values(fakeSecrets).join(' between ')} after`
    const scrubbed = scrub(message)

    expect(scrubbed).toMatch(/^before \[redacted\](?: between \[redacted\]){5} after$/)
    for (const secret of Object.values(fakeSecrets)) expect(scrubbed).not.toContain(secret)
  })

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

  it('scrubs standalone secrets from nested exception stacks before writing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    const diagnostics = new LocalDiagnostics(directory, vi.fn())
    await diagnostics.setEnabled(true)

    const error = new Error(`request failed with ${fakeSecrets.openAI}`, {
      cause: new Error(`provider returned ${fakeSecrets.anthropic}`),
    })
    error.stack = `${error.stack}\nCaused by: ${fakeSecrets.github}\n${fakeSecrets.slack}\n${fakeSecrets.jwt}\n${fakeSecrets.privateKey}`
    await diagnostics.record('provider failure', error)
    const log = await readFile(path.join(directory, 'errors.log'), 'utf8')

    expect(log).toContain('request failed with [redacted]')
    expect(log).toContain('Caused by: [redacted]')
    for (const secret of Object.values(fakeSecrets)) expect(log).not.toContain(secret)
  })
})
