import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  boundedEntry,
  localDiagnosticsDirectory,
  LocalDiagnostics,
  scrub,
} from './local-diagnostics.js'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true }))))

const fakeSecrets = {
  openAI: ['sk', 'proj', 'A'.repeat(32)].join('-'),
  anthropic: ['sk', 'ant', 'api03', 'B'.repeat(32)].join('-'),
  github: `ghp_${'C'.repeat(36)}`,
  slack: ['xoxb', '1234567890', 'D'.repeat(24)].join('-'),
  slackApp: ['xapp', '1', 'F'.repeat(10), 'G'.repeat(24)].join('-'),
  gitlab: `glpat-${'H'.repeat(20)}`,
  aws: `AKIA${'I'.repeat(16)}`,
  google: `AIza${'J'.repeat(35)}`,
  stripe: `sk_live_${'K'.repeat(24)}`,
  npm: `npm_${'L'.repeat(36)}`,
  slackWebhook: `https://hooks.slack.com/services/${'T'.repeat(9)}/${'B'.repeat(9)}/${'M'.repeat(24)}`,
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

    expect(scrubbed).toMatch(/^before \[redacted\](?: between \[redacted\]){12} after$/)
    for (const secret of Object.values(fakeSecrets)) expect(scrubbed).not.toContain(secret)
  })

  it('scrubs encrypted, DSA, and PGP private key blocks', () => {
    for (const label of ['ENCRYPTED PRIVATE KEY', 'DSA PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
      const block = `-----BEGIN ${label}-----\nRklYVFVSRS1OT1QtQS1LRVk=\n-----END ${label}-----`
      expect(scrub(`call failed: ${block} retry`)).toBe('call failed: [redacted] retry')
    }
  })

  it('scrubs keyed secrets and authorization schemes', () => {
    expect(scrub('password=hunter2 next')).toBe('password=[redacted] next')
    expect(scrub("secret: 't0ps3cret' rest")).toBe("secret: '[redacted]' rest")
    expect(scrub('api_key=AbCdEf123 end')).toBe('api_key=[redacted] end')
    expect(scrub('token: eyJhbGciOiJIUzI1NiJ9')).toBe('token: [redacted]')
    expect(scrub('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(
      'Authorization: Basic [redacted]',
    )
    expect(scrub('Bearer abcdef1234567890')).toBe('Bearer [redacted]')
  })

  it('leaves prose that mentions credential vocabulary untouched', () => {
    expect(scrub('the token expired before the tokenizer finished')).toBe(
      'the token expired before the tokenizer finished',
    )
    expect(scrub('password reset instructions were emailed')).toBe(
      'password reset instructions were emailed',
    )
    expect(scrub('a basic connectivity check failed')).toBe('a basic connectivity check failed')
  })

  it('stays off by default and scrubs sensitive error details when enabled', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    const diagnostics = new LocalDiagnostics(directory)
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

    expect(log).toContain('[home]\\work [email] token=[redacted]')
    expect(log).not.toContain('Leon')
    expect(log).not.toContain('secret')
  })

  it('scrubs standalone secrets from nested exception stacks before writing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    const diagnostics = new LocalDiagnostics(directory)
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

  it('serializes concurrent writes and rotates within byte bounds', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    const diagnostics = new LocalDiagnostics(directory)
    await diagnostics.setEnabled(true)

    await Promise.all(
      Array.from({ length: 180 }, (_, index) =>
        diagnostics.record(`worker-${index}`, `message-${index}-${'x'.repeat(4_000)}`),
      ),
    )

    const files = (await readdir(directory)).filter((name) => name.endsWith('.log')).sort()
    expect(files).toEqual(['errors.log', 'errors.previous.log'])
    for (const file of files) {
      expect((await stat(path.join(directory, file))).size).toBeLessThanOrEqual(512 * 1024)
      expect(await readFile(path.join(directory, file), 'utf8')).toMatch(/\n$/)
    }
  })

  it('bounds a single entry without splitting a UTF-8 character', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    const diagnostics = new LocalDiagnostics(directory)
    await diagnostics.setEnabled(true)

    await diagnostics.record('renderer', '€'.repeat(4_000))

    const log = await readFile(path.join(directory, 'errors.log'), 'utf8')
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(4 * 1024)
    expect(log).not.toContain('\uFFFD')
    expect(log).toMatch(/\n$/)
  })

  it('strips a partial UTF-8 character at the entry bound', () => {
    // The 4095-byte cut lands inside the three-byte euro sign.
    const entry = boundedEntry(`${'a'.repeat(4094)}€`)
    expect(Buffer.byteLength(entry)).toBeLessThanOrEqual(4 * 1024)
    expect(entry).not.toContain('\uFFFD')
    expect(entry).not.toContain('€')
    expect(entry).toMatch(/\n$/)
  })

  it('persists a fatal record synchronously', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    const diagnostics = new LocalDiagnostics(directory)

    diagnostics.recordSync('main crash', 'fatal before enable')
    await expect(readFile(path.join(directory, 'errors.log'), 'utf8')).rejects.toThrow()

    await diagnostics.setEnabled(true)
    diagnostics.recordSync('main crash', 'fatal: C:\\Users\\Leon\\work token=secret')

    const log = await readFile(path.join(directory, 'errors.log'), 'utf8')
    expect(log).toContain('[main crash] fatal: [home]\\work token=[redacted]')
    expect(log).not.toContain('secret')
  })

  it('rolls back the enabled flag when persistence fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(root)
    const blocker = path.join(root, 'not-a-directory')
    await writeFile(blocker, 'file, not a directory')
    const diagnostics = new LocalDiagnostics(path.join(blocker, 'diagnostics'))

    await expect(diagnostics.setEnabled(true)).rejects.toThrow()
    expect(diagnostics.isEnabled()).toBe(false)
  })

  it('invalidates queued records immediately when disabled', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    const diagnostics = new LocalDiagnostics(directory)
    await diagnostics.setEnabled(true)

    const queued = Array.from({ length: 20 }, (_, index) =>
      diagnostics.record('queued', `must-not-be-written-${index}`),
    )
    await diagnostics.setEnabled(false)
    await Promise.all(queued)

    await expect(readFile(path.join(directory, 'errors.log'), 'utf8')).rejects.toThrow()
    expect(diagnostics.isEnabled()).toBe(false)
  })

  it('persists only the latest rapid enable or disable request', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    const diagnostics = new LocalDiagnostics(directory)

    await Promise.all([
      diagnostics.setEnabled(true),
      diagnostics.setEnabled(false),
      diagnostics.setEnabled(true),
    ])
    expect(diagnostics.isEnabled()).toBe(true)
    expect(await readFile(path.join(directory, 'enabled'), 'utf8')).toBe('true')

    await Promise.all([
      diagnostics.setEnabled(false),
      diagnostics.setEnabled(true),
      diagnostics.setEnabled(false),
    ])
    expect(diagnostics.isEnabled()).toBe(false)
    await expect(readFile(path.join(directory, 'enabled'), 'utf8')).rejects.toThrow()
  })

  it('discards an oversized legacy text log instead of retaining it as a rotation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'errors.log'), 'x'.repeat(600 * 1024))
    const diagnostics = new LocalDiagnostics(directory)
    await diagnostics.setEnabled(true)

    await diagnostics.record('main', 'bounded replacement')

    expect((await stat(path.join(directory, 'errors.log'))).size).toBeLessThan(4 * 1024)
    await expect(stat(path.join(directory, 'errors.previous.log'))).rejects.toThrow()
  })

  it('keeps legacy native files outside the text diagnostics directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-diagnostics-'))
    directories.push(root)
    const legacyDump = path.join(root, 'legacy.dmp')
    const directory = localDiagnosticsDirectory(root)
    await writeFile(legacyDump, 'native dump fixture')
    const diagnostics = new LocalDiagnostics(directory)
    await diagnostics.setEnabled(true)
    await diagnostics.record('main', 'text only')

    expect(diagnostics.directory).toBe(directory)
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['enabled', 'errors.log']))
    expect(await readFile(legacyDump, 'utf8')).toBe('native dump fixture')
  })
})
