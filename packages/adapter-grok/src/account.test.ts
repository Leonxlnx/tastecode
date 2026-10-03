import { beforeEach, describe, expect, it, vi } from 'vitest'

type GrokTestState = {
  calls: string[]
  spawns: Array<{ command: string; args: string[]; options: unknown }>
  disposed: number
  response: unknown
}

const fake = vi.hoisted<GrokTestState>(() => ({
  calls: [],
  spawns: [],
  disposed: 0,
  response: undefined,
}))

vi.mock('@harness/proc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@harness/proc')>()),
  spawnOwned: vi.fn((command: string, args: string[], options: unknown) => {
    fake.spawns.push({ command, args, options })
    return { pid: 1 }
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
}))

const { grokCommand } = await import('./adapter.js')
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

beforeEach(() => {
  fake.calls = []
  fake.spawns = []
  fake.disposed = 0
  fake.response = undefined
})

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
