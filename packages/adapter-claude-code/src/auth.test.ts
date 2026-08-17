import type { SDKControlInitializeResponse, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { runCli } from '@harness/proc'
import { describe, expect, it, vi } from 'vitest'
import { claudeAccount, parseClaudeAccount } from './auth.js'
import type { ClaudeQueryFactory } from './sdk-runtime.js'

describe('Claude Code authentication', () => {
  it('does not collapse a failed status command into signed out', async () => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({ code: 1, stdout: '' })
    await expect(claudeAccount({ run })).rejects.toThrow('claude auth status exited with code 1')
  })

  it('accepts the logged-out JSON that Claude emits with exit code one', async () => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({ code: 1, stdout: '{"loggedIn":false}' })
    await expect(claudeAccount({ run })).resolves.toEqual({ signedIn: false })
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

  it('fills missing subscription details from SDK initialization without sending a prompt', async () => {
    const run = vi.fn<typeof runCli>().mockResolvedValue({
      code: 0,
      stdout: '{"loggedIn":true,"email":"dev@example.test"}',
    })
    let closed = false
    const initialization: SDKControlInitializeResponse = {
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: [],
      models: [],
      account: { email: 'dev@example.test', subscriptionType: 'max' },
    }
    const createQuery: ClaudeQueryFactory = () => ({
      initializationResult: async () => initialization,
      close: () => {
        closed = true
      },
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      supportedModels: async () => [],
      [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        return { next: async () => ({ done: true, value: undefined }) }
      },
    })

    await expect(claudeAccount({ createQuery, run })).resolves.toEqual({
      signedIn: true,
      email: 'dev@example.test',
      plan: 'max',
    })
    expect(closed).toBe(true)
  })
})
