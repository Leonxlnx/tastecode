import { describe, expect, it, vi } from 'vitest'
import type { Model } from '@harness/contracts'

vi.mock('../../modules/tastecode-link', () => ({ TasteLink: {} }))

const { desktopChoiceKey } = await import('../state/catalog')
const { catalogView } = await import('./catalog')

const model = (id: string, patch: Partial<Model> = {}): Model => ({
  id,
  displayName: id,
  isDefault: false,
  reasoningEfforts: [],
  serviceTiers: [],
  ...patch,
})

const claude = {
  provider: 'claude-code' as const,
  key: 'claude-code',
  name: 'Claude Code',
  capabilities: undefined,
  status: 'ready' as const,
  models: [
    model('opus', { isDefault: true }),
    model('sonnet'),
    model('claude-sonnet-5'),
    model('claude/x y'),
  ],
}

describe('model menus', () => {
  it('names models the way the desktop picker keys them', () => {
    expect(desktopChoiceKey({ provider: 'codex' }, 'gpt-5.5')).toBe('codex:gpt-5.5')
    expect(desktopChoiceKey({ provider: 'acp', agent: 'kimi' }, '')).toBe('acp:kimi:automatic')
    expect(desktopChoiceKey({ provider: 'api', connectionId: 'or' }, 'a/b')).toBe('api:or:a%2Fb')
    expect(desktopChoiceKey({ provider: 'codex', accountId: 'work' }, 'm')).toBe('codex:m')
  })

  it('offers what the desktop offers, in one list, once it says what it hides', () => {
    const hidden = new Set(['claude-code:claude-sonnet-5', 'claude-code:claude%2Fx%20y'])
    expect(
      catalogView({ status: 'ready', sources: [claude] }, hidden).sources[0]?.models.map(
        (entry) => [entry.id, entry.more],
      ),
    ).toEqual([
      ['opus', false],
      ['sonnet', false],
    ])
    // Without the desktop's list the curated models come first and the rest wait behind More.
    expect(
      catalogView({ status: 'ready', sources: [claude] }).sources[0]?.models.map(
        (entry) => entry.more,
      ),
    ).toEqual([false, true, true, true])
  })
})
