// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  rememberChipTokens,
  rememberedChipTokens,
  resetRememberedChipTokens,
} from './composer-chip-memory.js'

beforeEach(() => {
  localStorage.clear()
  resetRememberedChipTokens()
})

describe('composer chip memory', () => {
  it('remembers sent chip tokens across a restart', () => {
    rememberChipTokens([
      { token: '$cook', kind: 'skill' },
      { token: '/design-taste-frontend', kind: 'skill' },
    ])
    resetRememberedChipTokens()

    expect([...rememberedChipTokens()]).toEqual([
      ['$cook', 'skill'],
      ['/design-taste-frontend', 'skill'],
    ])
  })

  it('keeps the 200 most recent tokens', () => {
    rememberChipTokens(
      Array.from({ length: 205 }, (_, index) => ({
        token: `$skill-${index}`,
        kind: 'skill' as const,
      })),
    )
    rememberChipTokens([{ token: '$skill-0', kind: 'skill' }])
    resetRememberedChipTokens()

    const tokens = rememberedChipTokens()
    expect(tokens.size).toBe(200)
    expect(tokens.has('$skill-5')).toBe(false)
    expect(tokens.has('$skill-6')).toBe(true)
    expect([...tokens.keys()].at(-1)).toBe('$skill-0')
  })

  it('ignores a saved value it cannot read', () => {
    localStorage.setItem('harness.composerChipTokens', '{"not":"a list"}')
    expect(rememberedChipTokens().size).toBe(0)
    resetRememberedChipTokens()
    localStorage.setItem(
      'harness.composerChipTokens',
      '[["$ok","skill"],["$bad","tool"],[1,"mcp"]]',
    )
    expect([...rememberedChipTokens()]).toEqual([['$ok', 'skill']])
  })
})
