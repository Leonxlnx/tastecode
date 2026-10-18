import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Answer = { stdout: string; stderr: string; code: number }
type HeldCli = { finish(answer: Answer): void }

const fake = vi.hoisted(() => ({
  spawns: [] as Array<{ command: string; args: string[]; options: unknown }>,
  /** What the next `agy models` answers; null holds the process open. */
  answer: null as Answer | null,
  held: [] as HeldCli[],
  stdinEnded: 0,
}))

vi.mock('@harness/proc', async (importOriginal) => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  /** A one-shot CLI process as captureCli reads it. */
  class FakeCli extends EventEmitter {
    stdin = new PassThrough()
    stdout = new PassThrough()
    stderr = new PassThrough()
    exitCode: number | null = null
    signalCode = null
    pid = undefined
    constructor() {
      super()
      this.stdin.on('finish', () => (fake.stdinEnded += 1))
    }
    kill(): boolean {
      return true
    }
    finish(answer: Answer): void {
      this.stdout.end(answer.stdout)
      this.stderr.end(answer.stderr)
      this.exitCode = answer.code
      setImmediate(() => this.emit('close', answer.code, null))
    }
  }
  return {
    ...(await importOriginal<typeof import('@harness/proc')>()),
    spawnOwned: vi.fn((command: string, args: string[], options: unknown) => {
      fake.spawns.push({ command, args, options })
      const child = new FakeCli()
      const answer = fake.answer
      if (answer === null) fake.held.push(child)
      else queueMicrotask(() => child.finish(answer))
      return child
    }),
  }
})

const { spawnOwned } = await import('@harness/proc')
const { AntigravityAdapter } = await import('./adapter.js')
const { antigravityCommand } = await import('./command.js')
const { ANTIGRAVITY_SIGN_IN_REQUIRED, antigravityAccount, resetAntigravitySignInForTests } =
  await import('./sign-in.js')

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** agy 1.4.0, signed in, Windows pipes with stdin closed (2026-10-17). */
const SIGNED_IN: Answer = {
  stdout: fixture('agy-models-1.4.0.txt'),
  stderr: 'Fetching available models...\n',
  code: 0,
}
/** agy 1.4.0, signed out (captured 2026-10-16); the error's stream was not recorded. */
const SIGNED_OUT: Answer = {
  stdout: '',
  stderr: fixture('agy-models-signed-out-1.4.0.txt'),
  code: 1,
}

const modelReads = () => fake.spawns.filter((spawn) => spawn.args[0] === 'models').length

beforeEach(() => {
  fake.spawns = []
  fake.answer = SIGNED_IN
  fake.held = []
  fake.stdinEnded = 0
  resetAntigravitySignInForTests()
})

afterEach(() => vi.useRealTimers())

describe('antigravityAccount', () => {
  it('reports a signed-in agy from its model listing', async () => {
    await expect(antigravityAccount()).resolves.toEqual({ signedIn: true })
    expect(fake.spawns).toEqual([
      {
        command: antigravityCommand(),
        args: ['models'],
        options: { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      },
    ])
    expect(fake.stdinEnded).toBe(1)
  })

  it.each([
    ['stderr', SIGNED_OUT],
    ['stdout', { ...SIGNED_OUT, stdout: SIGNED_OUT.stderr, stderr: '' }],
  ])('reports signed out when agy asks for a sign-in on %s', async (_stream, answer) => {
    fake.answer = answer
    await expect(antigravityAccount()).resolves.toEqual({ signedIn: false })
  })

  it('rejects an answer that says neither, so the last known sign-in can stand', async () => {
    fake.answer = { stdout: '', stderr: 'Error: language server crashed\n', code: 2 }
    await expect(antigravityAccount()).rejects.toThrow('agy models exited with code 2')
  })

  it('gives a slow agy two minutes before it gives up', async () => {
    vi.useFakeTimers()
    fake.answer = null
    const account = antigravityAccount()
    const settled = vi.fn()
    account.then(settled, settled)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(account).rejects.toThrow('did not answer within 120 seconds')
  })
})

describe('one agy read for the sign-in check and the model list', () => {
  it('lets concurrent checks and a listing join one read under way', async () => {
    fake.answer = null
    const first = antigravityAccount()
    const second = antigravityAccount()
    const listing = new AntigravityAdapter().listModels()
    await vi.waitFor(() => expect(fake.held).toHaveLength(1))
    fake.held[0]!.finish(SIGNED_IN)

    await expect(first).resolves.toEqual({ signedIn: true })
    await expect(second).resolves.toEqual({ signedIn: true })
    await expect(listing).resolves.not.toHaveLength(0)
    expect(modelReads()).toBe(1)
  })

  it('reuses a signed-in answer for 30 seconds, then reads again', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      await antigravityAccount()
      clock.mockReturnValue(now + 29_999)
      await new AntigravityAdapter().listModels()
      await antigravityAccount()
      expect(modelReads()).toBe(1)
      clock.mockReturnValue(now + 30_000)
      await new AntigravityAdapter().listModels()
      expect(modelReads()).toBe(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('never reuses a signed-out answer, so a sign-in in agy shows at once', async () => {
    fake.answer = SIGNED_OUT
    await expect(antigravityAccount()).resolves.toEqual({ signedIn: false })
    await expect(new AntigravityAdapter().listModels()).rejects.toThrow(
      ANTIGRAVITY_SIGN_IN_REQUIRED,
    )
    expect(modelReads()).toBe(2)

    fake.answer = SIGNED_IN
    await expect(antigravityAccount()).resolves.toEqual({ signedIn: true })
    expect(modelReads()).toBe(3)
  })

  it('reads again after a read that failed', async () => {
    fake.answer = { stdout: '', stderr: '', code: 3 }
    await expect(antigravityAccount()).rejects.toThrow()
    fake.answer = SIGNED_IN
    await expect(antigravityAccount()).resolves.toEqual({ signedIn: true })
    expect(modelReads()).toBe(2)
  })

  it('never lends the answer to a custom harness, which launches its own binary', async () => {
    await antigravityAccount()
    await new AntigravityAdapter({ spawn: (...args) => spawnOwned(...args) }).listModels()
    expect(modelReads()).toBe(2)
  })
})
