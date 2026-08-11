import type { ProviderId } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  agentPresentation,
  connectionMark,
  providerPresentation,
  sourcePresentation,
} from './provider-presentation.js'

describe('provider presentation', () => {
  it.each([
    ['codex', 'Codex', 'openai'],
    ['claude-code', 'Claude Code', 'anthropic'],
    ['grok', 'Grok', 'grok'],
    ['cursor', 'Cursor', 'cursor'],
    ['opencode', 'OpenCode', 'opencode'],
    ['antigravity', 'Antigravity', 'antigravity'],
    ['acp', 'ACP', 'acp'],
    ['api', 'API connection', 'custom'],
  ] as const)('presents %s consistently', (provider, label, mark) => {
    expect(providerPresentation(provider satisfies ProviderId)).toEqual({ label, mark })
  })

  it('uses an ACP source name and mark instead of the generic transport identity', () => {
    expect(sourcePresentation({ provider: 'acp', sourceName: 'My Agent', mark: 'acp' })).toEqual({
      label: 'My Agent',
      mark: 'acp',
    })
  })

  it.each([
    ['gemini', 'Gemini CLI', 'gemini'],
    ['kimi', 'Kimi CLI', 'kimi'],
    ['qwen', 'Qwen Code', 'qwen'],
    ['third-party-agent', 'third-party-agent', 'acp'],
  ] as const)('presents the %s ACP source by product name', (agent, label, mark) => {
    expect(agentPresentation(agent)).toEqual({ label, mark })
  })

  it('uses an API connection name and preset mark instead of the generic transport identity', () => {
    expect(
      sourcePresentation({
        provider: 'api',
        sourceName: 'Work OpenRouter',
        mark: connectionMark('openrouter'),
      }),
    ).toEqual({ label: 'Work OpenRouter', mark: 'openrouter' })
  })

  it('does not let a transport override a direct provider product identity', () => {
    expect(sourcePresentation({ provider: 'codex', sourceName: 'OpenAI', mark: 'custom' })).toEqual(
      { label: 'Codex', mark: 'openai' },
    )
  })

  it('ignores an empty source override and keeps the honest generic fallback', () => {
    expect(sourcePresentation({ provider: 'api', sourceName: '  ' })).toEqual({
      label: 'API connection',
      mark: 'custom',
    })
  })
})
