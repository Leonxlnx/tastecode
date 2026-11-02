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

describe('image files and per-model images', () => {
  const status = (
    id: ProviderStatus['id'],
    extra: Partial<ReturnType<typeof capabilities>> & { imageFiles?: boolean },
    images = false,
  ): ProviderStatus => ({
    id,
    displayName: id,
    installed: true,
    auth: 'authenticated',
    capabilities: { ...capabilities(images), ...extra },
  })

  it('accepts images an engine hands over as files, for every model and agent', () => {
    const providers = [
      status('antigravity', { imageFiles: true }),
      status('acp', { imageFiles: true }),
    ]
    expect(sourceSupportsAttachments({ provider: 'antigravity' }, providers)).toBe(true)
    expect(
      sourceSupportsAttachments(
        { provider: 'acp', agentId: 'gemini', modelImages: false },
        providers,
      ),
    ).toBe(true)
  })

  it('lets a model narrow pixels, and asks an agent-scoped model to declare them', () => {
    const providers = [status('opencode', {}, true), status('pi', {}, true)]
    expect(sourceSupportsAttachments({ provider: 'opencode' }, providers)).toBe(true)
    expect(sourceSupportsAttachments({ provider: 'opencode', modelImages: false }, providers)).toBe(
      false,
    )
    expect(sourceSupportsAttachments({ provider: 'pi', agentId: 'local' }, providers)).toBe(false)
    expect(
      sourceSupportsAttachments({ provider: 'pi', agentId: 'local', modelImages: true }, providers),
    ).toBe(true)
  })

  it('still refuses an engine that declares neither', () => {
    expect(sourceSupportsAttachments({ provider: 'cursor' }, [status('cursor', {})])).toBe(false)
  })
})
