// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  readProviderRoster,
  rosterAllows,
  seedProviderRoster,
  writeProviderRoster,
} from './provider-roster.js'

afterEach(() => localStorage.clear())

describe('provider roster', () => {
  it('lets through only what was added, once there is a roster', () => {
    const roster = ['codex', 'acp:devin']
    expect(rosterAllows(roster, 'codex')).toBe(true)
    expect(rosterAllows(roster, 'claude-code')).toBe(false)
    expect(rosterAllows(roster, 'acp:devin')).toBe(true)
    expect(rosterAllows(roster, 'acp:kimi')).toBe(false)
    // API connections and custom harnesses are added in their own places.
    expect(rosterAllows(roster, 'api:openai-1')).toBe(true)
    expect(rosterAllows(roster, 'claude-code:my-harness')).toBe(true)
  })

  it('keeps every direct provider and no ACP agent before the roster exists', () => {
    expect(rosterAllows(undefined, 'grok')).toBe(true)
    expect(rosterAllows(undefined, 'acp:devin')).toBe(false)
  })

  it('starts from the installed providers and every source with a chat', () => {
    expect(
      seedProviderRoster({
        providers: [
          { id: 'codex', installed: true },
          { id: 'grok', installed: false },
          { id: 'claude-code', installed: true },
          { id: 'acp', installed: true },
        ],
        projects: [
          {
            sessions: [
              { provider: 'grok' },
              { provider: 'acp', agent: 'devin' },
              { provider: 'claude-code', agent: 'my-harness' },
              { provider: 'codex' },
            ],
          },
        ],
      }),
    ).toEqual(['claude-code', 'codex', 'grok', 'acp:devin'])
  })

  it('reads nothing until saved, then exactly what was saved', () => {
    expect(readProviderRoster()).toBeUndefined()
    writeProviderRoster(['codex', 'acp:devin', 'codex'])
    expect(readProviderRoster()).toEqual(['codex', 'acp:devin'])
    writeProviderRoster([])
    expect(readProviderRoster()).toEqual([])
  })
})
