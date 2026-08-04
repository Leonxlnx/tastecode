import { describe, expect, it } from 'vitest'
import { parseAcpThreadId } from './adapter.js'
import { discoverAgentModels, findAgentSpec, parseKimiModels } from './agents.js'

describe('ACP persisted sessions', () => {
  it('keeps provider-native session ids intact', () => {
    expect(parseAcpThreadId('acp-kimi-session_abc-123', 'kimi')).toBe('session_abc-123')
    expect(() => parseAcpThreadId('acp-gemini-session_abc', 'kimi')).toThrow('does not belong')
  })

  it('records the Kimi wire version verified by the real binary', () => {
    expect(findAgentSpec('kimi')).toMatchObject({
      command: 'kimi',
      args: ['acp'],
      verified: true,
      supportedVersion: '0.29',
    })
  })
})

describe('ACP model discovery', () => {
  it('uses Gemini CLI model aliases instead of a fake generic default', async () => {
    expect(await discoverAgentModels('gemini')).toMatchObject([
      { id: 'auto', displayName: 'Auto (Gemini)', isDefault: true },
      { id: 'pro' },
      { id: 'flash' },
      { id: 'flash-lite' },
    ])
  })

  it('normalizes the models reported by Kimi itself', () => {
    expect(
      parseKimiModels(
        JSON.stringify({
          models: {
            'kimi-code/k3': {
              displayName: 'Kimi K3',
              supportEfforts: ['low', 'high'],
              defaultEffort: 'high',
            },
          },
        }),
      ),
    ).toEqual([
      {
        id: 'kimi-code/k3',
        displayName: 'Kimi K3',
        isDefault: true,
        reasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [],
      },
    ])
  })
})
