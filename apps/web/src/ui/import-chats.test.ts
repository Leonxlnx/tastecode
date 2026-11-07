import type { ChatImportChat, ChatImportScan } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import {
  ALL_SOURCES,
  archivedCount,
  checkState,
  folderGroups,
  lastUsed,
  selectionSummary,
  sourceCounts,
  toggled,
} from './import-chats.js'

function chat(id: string, overrides: Partial<ChatImportChat> = {}): ChatImportChat {
  return {
    id,
    source: 'codex',
    title: id,
    folder: '/work/site',
    provider: 'codex',
    createdAt: 1,
    updatedAt: 10,
    continuation: 'session',
    imported: false,
    ...overrides,
  }
}

const scan = (chats: ChatImportChat[]): ChatImportScan => ({
  sources: [
    { id: 'codex', name: 'Codex', provider: 'codex', state: 'ready' },
    { id: 't3-code', name: 'T3 Code', state: 'ready' },
  ],
  chats,
  folders: [
    { path: '/work/site', name: 'site', label: '~/site', isProject: false, missing: false },
    { path: '/work/api', name: 'api', label: '~/api', isProject: true, missing: false },
  ],
})

const view = (overrides = {}) => ({ source: ALL_SOURCES, query: '', archived: false, ...overrides })

describe('import counts', () => {
  it('counts what is left, once overall and for every source that saved it', () => {
    const counts = sourceCounts(
      scan([
        chat('one'),
        chat('two', { source: 't3-code', alsoIn: ['codex'] }),
        chat('done', { imported: true }),
        chat('old', { archived: true }),
      ]),
      false,
    )
    expect(Object.fromEntries(counts)).toEqual({ all: 2, codex: 2, 't3-code': 1 })
  })

  it('prints a zero for a source with nothing left instead of dropping it', () => {
    expect(sourceCounts(scan([chat('done', { imported: true })]), false).get('codex')).toBe(0)
  })

  it('counts archived chats only when they are shown', () => {
    const archived = scan([chat('old', { archived: true })])
    expect(sourceCounts(archived, true).get(ALL_SOURCES)).toBe(1)
    expect(archivedCount(archived)).toBe(1)
  })
})

describe('import folders', () => {
  it('sorts folders and their chats by last use, and leaves out finished folders', () => {
    const groups = folderGroups(
      scan([
        chat('old', { updatedAt: 5 }),
        chat('new', { updatedAt: 9 }),
        chat('recent', { folder: '/work/api', updatedAt: 20 }),
        chat('done', { folder: '/work/gone', imported: true }),
      ]),
      view(),
    )
    expect(groups.map(({ folder }) => folder.name)).toEqual(['api', 'site'])
    expect(groups[1]?.chats.map(({ id }) => id)).toEqual(['new', 'old'])
    expect(groups[1]?.updatedAt).toBe(9)
  })

  it('finds a chat by title and a whole folder by its path', () => {
    const list = scan([chat('Fix the header'), chat('Trace', { folder: '/work/api' })])
    expect(folderGroups(list, view({ query: 'HEADER' }))[0]?.chats).toHaveLength(1)
    expect(folderGroups(list, view({ query: '~/api' }))[0]?.folder.name).toBe('api')
    expect(folderGroups(list, view({ query: 'nothing' }))).toEqual([])
  })

  it('lists a chat under every source that saved it', () => {
    const list = scan([chat('shared', { source: 't3-code', alsoIn: ['codex'] })])
    expect(folderGroups(list, view({ source: 'codex' }))).toHaveLength(1)
    expect(folderGroups(list, view({ source: 't3-code' }))).toHaveLength(1)
  })
})

describe('import selection', () => {
  it('says what Import would do, also for chats chosen in another view', () => {
    const list = scan([
      chat('one'),
      chat('two', { folder: '/work/api' }),
      chat('done', { imported: true }),
    ])
    expect(selectionSummary(list, new Set(['one', 'two', 'done', 'gone']))).toEqual({
      ids: ['one', 'two'],
      chats: 2,
      folders: 2,
      newProjects: 1,
    })
  })

  it('ticks everything from some, and clears only from all', () => {
    const chats = [chat('one'), chat('two')]
    expect(checkState(chats, new Set())).toEqual({ state: 'none', chosen: 0 })
    expect(checkState(chats, new Set(['one']))).toEqual({ state: 'some', chosen: 1 })
    expect([...toggled(new Set(['one']), chats)].sort()).toEqual(['one', 'two'])
    expect([...toggled(new Set(['one', 'two', 'other']), chats)]).toEqual(['other'])
  })
})

describe('import dates', () => {
  const now = new Date('2026-11-07T12:00:00Z').getTime()
  it.each([
    [now - 5 * 60_000, 'Just now'],
    [now - 3_600_000, '1 hour ago'],
    [now - 5 * 3_600_000, '5 hours ago'],
    [now - 30 * 3_600_000, 'Yesterday'],
    [now - 4 * 86_400_000, '4 days ago'],
  ])('reads %s', (at, expected) => {
    expect(lastUsed(at, now)).toBe(expected)
  })

  it('names the year only when it is not this one', () => {
    expect(lastUsed(new Date('2025-03-02T12:00:00Z').getTime(), now)).toMatch(/2025/)
    expect(lastUsed(new Date('2026-03-02T12:00:00Z').getTime(), now)).not.toMatch(/2026/)
  })
})
