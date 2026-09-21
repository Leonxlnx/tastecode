import { runCli } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { claudeAccount, parseClaudeAccount } from './auth.js'

describe('Claude Code authentication', () => {
  it.each([
    { email: 'dev@example.test', subscriptionType: null },
    { email: null, subscriptionType: 'pro' },
    { email: null, subscriptionType: null },
  ])('accepts nullable account metadata: %j', async (metadata) => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', ...metadata }),
    })
    await expect(claudeAccount({ run })).resolves.toEqual({
      signedIn: true,
      ...(metadata.email ? { email: metadata.email } : {}),
      ...(metadata.subscriptionType ? { plan: metadata.subscriptionType } : {}),
    })
  })

  it('does not collapse a failed status command into signed out', async () => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({ code: 1, stdout: '' })
    await expect(claudeAccount({ run })).rejects.toThrow('claude auth status exited with code 1')
  })

  it('accepts the logged-out JSON that Claude emits with exit code one', async () => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({ code: 1, stdout: '{"loggedIn":false}' })
    await expect(claudeAccount({ run })).resolves.toEqual({ signedIn: false })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('claude', ['auth', 'status'])
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

  it('uses CLI auth status as the complete account authority', async () => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({
      code: 0,
      stdout:
        '{"loggedIn":true,"authMethod":"third_party","apiProvider":"vertex","email":"dev@example.test"}',
    })

    await expect(claudeAccount({ run })).resolves.toEqual({
      signedIn: true,
      email: 'dev@example.test',
    })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('claude', ['auth', 'status'])
  })
})
