import { describe, expect, it } from 'vitest'
import { methods } from './protocol.js'

describe('model connection protocol', () => {
  it('keeps credentials write-only on the wire', () => {
    expect(
      methods['connections.setCredential'].params.parse({
        connectionId: 'personal-openai',
        apiKey: 'test-only-value',
      }),
    ).toEqual({ connectionId: 'personal-openai', apiKey: 'test-only-value' })
    expect(
      methods['connections.setCredential'].result.parse({
        credentialConfigured: true,
        apiKey: 'must-not-return',
      }),
    ).toEqual({ credentialConfigured: true })
  })

  it('requires a named connection only for direct API sessions', () => {
    expect(
      methods['thread.start'].params.parse({
        provider: 'api',
        connectionId: 'personal-openai',
        workspacePath: 'D:\\repo',
      }),
    ).toMatchObject({ provider: 'api', connectionId: 'personal-openai' })
    expect(() =>
      methods['thread.start'].params.parse({ provider: 'api', workspacePath: 'D:\\repo' }),
    ).toThrow()
    expect(() =>
      methods['thread.start'].params.parse({
        provider: 'codex',
        connectionId: 'personal-openai',
        workspacePath: 'D:\\repo',
      }),
    ).toThrow()
  })

  it('preserves each saved chat API connection when listing projects', () => {
    const sessions = ['personal-openai', 'work-openai'].map((connectionId, index) => ({
      id: `thread-${index}`,
      title: 'API chat',
      provider: 'api',
      connectionId,
      createdAt: 1,
      running: false,
    }))
    const projects = [{ path: 'D:\\repo', name: 'repo', pinned: false, createdAt: 1, sessions }]
    expect(methods['projects.list'].result.parse({ projects }).projects[0]?.sessions).toEqual(
      sessions,
    )
  })
})
