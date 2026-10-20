// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { ProviderStatus } from '@harness/contracts'
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
        capabilities: capabilities(true),
      },
      {
        id: 'grok',
        displayName: 'Grok',
        installed: true,
        auth: 'authenticated',
        capabilities: capabilities(true),
      },
    ]

    expect(sourceSupportsAttachments({ provider: 'codex' }, providers)).toBe(true)
    expect(sourceSupportsAttachments({ provider: 'claude-code' }, providers)).toBe(true)
    expect(sourceSupportsAttachments({ provider: 'grok' }, providers)).toBe(true)
    expect(sourceSupportsAttachments({ provider: 'acp', agentId: 'gemini' }, providers)).toBe(false)
  })

  it('fails closed for a source from a removed API connection', () => {
    expect(sourceSupportsAttachments({ provider: 'api', connectionId: 'work-openai' }, [])).toBe(
      false,
    )
  })
})
