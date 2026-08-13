// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { ModelConnection, ProviderStatus } from '@harness/contracts'
import { sourceSupportsAttachments } from './attachment-capability.js'

const capabilities = (images: boolean) => ({
  steer: false,
  fork: false,
  interrupt: true,
  reasoningItems: false,
  approvals: false,
  images,
})

describe('source attachment capability', () => {
  it('follows each direct provider declaration and fails closed for a parked source', () => {
    const providers: ProviderStatus[] = [
      {
        id: 'codex',
        displayName: 'Codex',
        installed: true,
        auth: 'authenticated',
        capabilities: capabilities(true),
      },
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        installed: true,
        auth: 'authenticated',
        capabilities: capabilities(false),
      },
      {
        id: 'grok',
        displayName: 'Grok',
        installed: true,
        auth: 'authenticated',
        capabilities: capabilities(false),
      },
    ]

    expect(sourceSupportsAttachments({ provider: 'codex' }, providers, [])).toBe(true)
    expect(sourceSupportsAttachments({ provider: 'claude-code' }, providers, [])).toBe(false)
    expect(sourceSupportsAttachments({ provider: 'grok' }, providers, [])).toBe(false)
    expect(sourceSupportsAttachments({ provider: 'acp', agentId: 'gemini' }, providers, [])).toBe(
      false,
    )
  })

  it('uses the selected named API connection instead of a provider-wide assumption', () => {
    const connections: ModelConnection[] = [
      {
        id: 'work-openai',
        displayName: 'Work OpenAI',
        preset: 'openai',
        transport: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        credentialConfigured: true,
        capabilities: {
          streaming: true,
          tools: true,
          images: false,
          reasoning: true,
          modelDiscovery: true,
          usage: true,
        },
      },
    ]

    expect(
      sourceSupportsAttachments({ provider: 'api', connectionId: 'work-openai' }, [], connections),
    ).toBe(false)
    expect(
      sourceSupportsAttachments(
        { provider: 'api', connectionId: 'missing-connection' },
        [],
        connections,
      ),
    ).toBe(false)
  })
})
