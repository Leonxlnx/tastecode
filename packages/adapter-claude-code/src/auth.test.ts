import { runCli } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { claudeAccount, parseClaudeAccount } from './auth.js'

vi.mock('@harness/proc', () => ({ runCli: vi.fn(), killTree: vi.fn(), spawnCli: vi.fn() }))

describe('Claude Code authentication', () => {
  it('does not collapse a failed status command into signed out', async () => {
    vi.mocked(runCli).mockResolvedValue({ code: 1, stdout: '' })
    await expect(claudeAccount()).rejects.toThrow('claude auth status exited with code 1')
  })

  it('accepts the logged-out JSON that Claude emits with exit code one', async () => {
    vi.mocked(runCli).mockResolvedValue({ code: 1, stdout: '{"loggedIn":false}' })
    await expect(claudeAccount()).resolves.toEqual({ signedIn: false })
  })

  it('maps the CLI status without retaining vendor-only account fields', () => {
    expect(
      parseClaudeAccount(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'dev@example.test',
          subscriptionType: 'pro',
          orgId: 'private-vendor-field',
        }),
      ),
    ).toEqual({ signedIn: true, email: 'dev@example.test', plan: 'pro' })
  })
})
