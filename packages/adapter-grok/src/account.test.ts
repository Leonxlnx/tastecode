import { beforeEach, describe, expect, it, vi } from 'vitest'

type CliChild = { finish(output: string): void }

type GrokTestState = {
  calls: string[]
  spawns: Array<{ command: string; args: string[]; options: unknown }>
  disposed: number
  response: unknown
  /** What each `grok models` prints; null holds the process open. */
  modelsOutput: string | null
  held: CliChild[]
}

const fake = vi.hoisted<GrokTestState>(() => ({
  calls: [],
  spawns: [],
  disposed: 0,
  response: undefined,
  modelsOutput: '',
  held: [],
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
    kill(): boolean {
      return true
    }
    finish(output: string): void {
      this.stdout.end(output)
      this.stderr.end()
      this.exitCode = 0
      setImmediate(() => this.emit('close', 0, null))
    }
  }
  return {
    ...(await importOriginal<typeof import('@harness/proc')>()),
    spawnOwned: vi.fn((command: string, args: string[], options: unknown) => {
      fake.spawns.push({ command, args, options })
      if (args[0] === 'agent') return { pid: 1 }
      const child = new FakeCli()
      const output = args[0] === 'models' ? fake.modelsOutput : ''
      if (output === null) fake.held.push(child)
      else queueMicrotask(() => child.finish(output))
      return child
    }),
    StdioJsonRpc: class {
      request(method: string): Promise<unknown> {
        fake.calls.push(method)
        if (method === 'initialize') return Promise.resolve({ protocolVersion: 1 })
        return Promise.resolve(fake.response)
      }
      dispose(): void {
        fake.disposed += 1
      }
    },
  }
})

const { spawnOwned } = await import('@harness/proc')
const { grokCommand, GrokAdapter, signOutGrok } = await import('./adapter.js')
const { grokAccount, parseGrokSubscription } = await import('./account.js')

/** Shape captured from Grok Build 1.0.46; identifiers replaced. */
const CHECK_SUBSCRIPTION = {
  authenticated: true,
  meta: {
    email: 'dev@example.com',
    auth_mode: 'Oidc',
    team_id: '00000000-0000-0000-0000-000000000000',
    is_team_principal: false,
    team_name: null,
    is_zdr: false,
    team_role: null,
    coding_data_retention_opt_out: true,
    can_administer_team: null,
    show_resolved_model: false,
    gate: null,
    subscription_tier: 'X Premium',
    feedback_trace_offer: false,
    backend_billed: false,
  },
}

beforeEach(async () => {
  // Signing out also drops a model list an earlier sign-in check left to share.
  await signOutGrok()
  fake.calls = []
  fake.spawns = []
  fake.disposed = 0
  fake.response = undefined
  fake.modelsOutput = ''
  fake.held = []
})

const SIGNED_IN_MODELS = [
  'Default model: grok-4.5',
  '',
  'Available models:',
  '  * grok-4.5 (default)',
  '  - grok-4.6',
  '',
].join('\n')
const SIGNED_OUT_MODELS = ['You are not authenticated.', '', SIGNED_IN_MODELS].join('\n')

const modelReads = () => fake.spawns.filter((spawn) => spawn.args[0] === 'models').length

describe('parseGrokSubscription', () => {
  it('reads the email and the tier as the plan', () => {
    expect(parseGrokSubscription(CHECK_SUBSCRIPTION)).toEqual({
      email: 'dev@example.com',
      plan: 'X Premium',
    })
  })

  it('treats null or blank display fields as absent', () => {
    expect(
      parseGrokSubscription({ authenticated: true, meta: { email: null, subscription_tier: ' ' } }),
    ).toEqual({})
    expect(parseGrokSubscription({ authenticated: true, meta: null })).toEqual({})
  })

  it('reads nothing from an unauthenticated or unrecognized answer', () => {
    expect(parseGrokSubscription({ ...CHECK_SUBSCRIPTION, authenticated: false })).toBeUndefined()
    expect(parseGrokSubscription({ meta: CHECK_SUBSCRIPTION.meta })).toBeUndefined()
    expect(parseGrokSubscription(undefined)).toBeUndefined()
  })
})

describe('grokAccount', () => {
  it('reports signed out without starting provider ACP', async () => {
    const subscription = vi.fn()

    await expect(
      grokAccount({ signIn: async () => ({ signedIn: false }), subscription }),
    ).resolves.toEqual({ signedIn: false })
    expect(subscription).not.toHaveBeenCalled()
    expect(fake.spawns).toEqual([])
  })

  it('adds the email and plan to a signed-in account', async () => {
    await expect(
      grokAccount({
        signIn: async () => ({ signedIn: true }),
        subscription: async () => ({ email: 'dev@example.com', plan: 'X Premium' }),
      }),
    ).resolves.toEqual({ signedIn: true, email: 'dev@example.com', plan: 'X Premium' })
  })

  it('stays signed in when the subscription read fails', async () => {
    await expect(
      grokAccount({
        signIn: async () => ({ signedIn: true }),
        subscription: () => Promise.reject(new Error('grok account did not answer in time')),
      }),
    ).resolves.toEqual({ signedIn: true })
  })

  it('reads the subscription through the resolved Grok binary and provider ACP', async () => {
    fake.response = CHECK_SUBSCRIPTION

    await expect(grokAccount({ signIn: async () => ({ signedIn: true }) })).resolves.toEqual({
      signedIn: true,
      email: 'dev@example.com',
      plan: 'X Premium',
    })
    expect(fake.calls).toEqual(['initialize', '_x.ai/auth/check_subscription'])
    expect(fake.spawns).toEqual([
      {
        command: grokCommand(),
        args: ['agent', '--no-leader', 'stdio'],
        options: { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      },
    ])
    expect(fake.disposed).toBe(1)
  })
})

describe('Grok model list after an account check', () => {
  it('answers from the signed-in check that just ran grok models', async () => {
    fake.modelsOutput = SIGNED_IN_MODELS
    fake.response = CHECK_SUBSCRIPTION

    await expect(grokAccount()).resolves.toMatchObject({ signedIn: true })
    const models = await new GrokAdapter().listModels()

    expect(models.map((model) => model.id)).toEqual(['grok-4.5', 'grok-4.6'])
    expect(modelReads()).toBe(1)
    // A custom harness launches its own binary and never borrows the answer.
    await new GrokAdapter({ spawn: (...args) => spawnOwned(...args) }).listModels()
    expect(modelReads()).toBe(2)
  })

  it('joins a check that is still running', async () => {
    fake.modelsOutput = null
    const account = grokAccount()
    await vi.waitFor(() => expect(fake.held).toHaveLength(1))
    const listing = new GrokAdapter().listModels()

    fake.response = CHECK_SUBSCRIPTION
    fake.held[0]!.finish(SIGNED_IN_MODELS)
    await expect(account).resolves.toMatchObject({ signedIn: true })
    await expect(listing).resolves.toHaveLength(2)
    expect(modelReads()).toBe(1)
  })

  it('reads its own list after a signed-out check, a sign-out, or the share window', async () => {
    fake.modelsOutput = SIGNED_OUT_MODELS
    await expect(grokAccount()).resolves.toEqual({ signedIn: false })
    await new GrokAdapter().listModels()
    expect(modelReads()).toBe(2)

    fake.modelsOutput = SIGNED_IN_MODELS
    await grokAccount()
    await new GrokAdapter().listModels()
    expect(modelReads()).toBe(3)
    await signOutGrok()
    await new GrokAdapter().listModels()
    expect(modelReads()).toBe(4)

    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      await grokAccount()
      clock.mockReturnValue(now + 29_999)
      await new GrokAdapter().listModels()
      expect(modelReads()).toBe(5)
      clock.mockReturnValue(now + 30_000)
      await new GrokAdapter().listModels()
      expect(modelReads()).toBe(6)
    } finally {
      clock.mockRestore()
    }
  })
})
