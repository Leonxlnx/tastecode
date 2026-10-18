import type { ProviderId } from '@harness/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** What each vendor call was asked to run as. */
const calls = vi.hoisted(() => ({ claude: [] as unknown[][], codex: [] as unknown[] }))

vi.mock('@harness/adapter-claude-code', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-claude-code')>()
  return {
    ...original,
    claudeAccount: async (options?: unknown) => {
      calls.claude.push(['account', options])
      return { signedIn: true, email: 'work@example.test' }
    },
    claudeLimitSource: async (options?: unknown) => {
      calls.claude.push(['limits', options])
      return { status: 'ready', limits: [] }
    },
    startClaudeLogin: (_complete: unknown, options?: unknown) => {
      calls.claude.push(['login', options])
      return { loginId: 'login-1', cancel: async () => {} }
    },
    signOutClaude: async (options?: unknown) => {
      calls.claude.push(['signOut', options])
    },
  }
})

vi.mock('@harness/adapter-codex', async (importOriginal) => {
  const original = await importOriginal<typeof import('@harness/adapter-codex')>()
  return {
    ...original,
    CodexAdapter: class {
      constructor(options?: unknown) {
        calls.codex.push(options)
      }
      on(): void {}
      onUsageChanged(): void {}
      async start(): Promise<void> {}
      async dispose(): Promise<void> {}
      async account() {
        return { signedIn: true }
      }
    },
  }
})

const { ProviderControls } = await import('./provider-controls.js')

const opened: Array<InstanceType<typeof ProviderControls>> = []
function controls(accountHome?: string, providers?: ProviderId[]) {
  const created = new ProviderControls({
    listModels: async () => [],
    accountHome,
    providers,
    controlIdleMs: 0,
  })
  opened.push(created)
  return created
}

beforeEach(() => {
  calls.claude.length = 0
  calls.codex.length = 0
})
afterEach(async () => {
  await Promise.all(opened.splice(0).map((each) => each.disposeAll()))
})

describe('provider controls for one account', () => {
  it("makes Claude's sign-in, limit and sign-out calls as the account in its folder", async () => {
    const home = 'D:\\accounts\\claude-code\\work-1a2b3c'
    const claude = controls(home, ['claude-code']).forProvider('claude-code')
    await claude.account()
    await claude.usageLimitSource('visible')
    await claude.startLogin!()
    await claude.signOut()

    expect(calls.claude).toEqual([
      ['account', { accountHome: home }],
      ['limits', { accountHome: home }],
      ['login', { accountHome: home }],
      ['signOut', { accountHome: home }],
    ])

    // The default account's calls stay exactly as they were.
    calls.claude.length = 0
    await controls().forProvider('claude-code').account()
    expect(calls.claude).toEqual([['account', undefined]])
  })

  it('starts a Codex control process of its own for each account folder', async () => {
    const work = 'D:\\accounts\\codex\\work-1a2b3c'
    const client = 'D:\\accounts\\codex\\client-4d5e6f'
    await controls(work, ['codex']).forProvider('codex').account()
    await controls(client, ['codex']).forProvider('codex').account()
    await controls().forProvider('codex').account()

    expect(calls.codex).toEqual([{ accountHome: work }, { accountHome: client }, {}])
  })

  it('serves only its own providers and refuses one that cannot run as an account', () => {
    const home = 'D:\\accounts\\claude-code\\work-1a2b3c'
    expect(() => controls(home, ['claude-code']).forProvider('codex')).toThrow(
      'unknown provider "codex"',
    )
    expect(() => controls(home, ['grok'])).toThrow('grok cannot run as another account')
  })
})
