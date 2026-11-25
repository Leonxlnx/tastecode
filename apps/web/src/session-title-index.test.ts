import { describe, expect, it } from 'vitest'
import {
  createSessionTitleIndex,
  createSessionTitleIndexer,
  createSessionTitleSearcher,
  searchSessionTitles,
  type SessionTitleIndexEntry,
  type SessionTitleSearchOptions,
} from './session-title-index.js'

const projects = [
  {
    path: '/alpha',
    sessions: [
      { id: 'contains-old', title: 'Old alpha notes', provider: 'codex' as const, createdAt: 1 },
      { id: 'starts', title: 'Alpha plan', provider: 'grok' as const, createdAt: 2 },
      { id: 'exact', title: 'Alpha', provider: 'codex' as const, createdAt: 3 },
      { id: 'contains-new', title: 'New alpha notes', provider: 'codex' as const, createdAt: 4 },
    ],
  },
  {
    path: 'C:\\beta',
    name: 'Beta project',
    sessions: [{ id: 'beta', title: 'Alpha from beta', provider: 'codex' as const, createdAt: 5 }],
  },
]

describe('session title index', () => {
  it('ranks exact, prefix, and newest contains matches without sorting every hit', () => {
    const index = createSessionTitleIndex(projects)

    expect(searchSessionTitles(index, ['alpha']).map((entry) => entry.threadId)).toEqual([
      'exact',
      'beta',
      'starts',
      'contains-new',
      'contains-old',
    ])
  })

  it('applies project, provider, and result limits', () => {
    const index = createSessionTitleIndex(projects)

    expect(
      searchSessionTitles(index, ['alpha'], {
        projectPath: '/alpha',
        provider: 'codex',
        limit: 2,
      }).map((entry) => entry.threadId),
    ).toEqual(['exact', 'contains-new'])
    expect(index.find((entry) => entry.threadId === 'beta')?.projectName).toBe('Beta project')
  })

  it('retains the index for status-only updates and replaces changed titles', () => {
    const indexTitles = createSessionTitleIndexer()
    const initial = indexTitles(projects)
    const statusUpdated = projects.map((project, projectIndex) =>
      projectIndex === 0
        ? {
            ...project,
            sessions: project.sessions.map((session, sessionIndex) =>
              sessionIndex === 0 ? { ...session, status: 'working' } : session,
            ),
          }
        : project,
    )
    const retained = indexTitles(statusUpdated)
    const renamed = statusUpdated.map((project, projectIndex) =>
      projectIndex === 0
        ? {
            ...project,
            sessions: project.sessions.map((session, sessionIndex) =>
              sessionIndex === 0 ? { ...session, title: 'Renamed chat' } : session,
            ),
          }
        : project,
    )
    const updated = indexTitles(renamed)

    expect(retained).toBe(initial)
    expect(updated).not.toBe(initial)
    expect(updated[1]).toBe(initial[1])
    expect(updated[0]).toMatchObject({
      threadId: 'contains-old',
      threadTitle: 'Renamed chat',
      normalizedTitle: 'renamed chat',
    })
  })
  it('searches only the previous matches when the query is extended', () => {
    let titleReads = 0
    const index = createSessionTitleIndex(
      Array.from({ length: 10 }, (_, projectIndex) => ({
        path: `/project-${projectIndex}`,
        sessions: Array.from({ length: 200 }, (_, sessionIndex) => ({
          id: `thread-${projectIndex}-${sessionIndex}`,
          title: sessionIndex % 100 === 0 ? `Zebra ${sessionIndex}` : `Chat ${sessionIndex}`,
          provider: 'codex' as const,
          createdAt: sessionIndex,
        })),
      })),
    ).map((entry) => {
      const { normalizedTitle, ...rest } = entry
      return Object.defineProperty(rest, 'normalizedTitle', {
        enumerable: true,
        get() {
          titleReads += 1
          return normalizedTitle
        },
      }) as SessionTitleIndexEntry
    })
    const search = createSessionTitleSearcher()
    expect(search(index, ['z'])).toHaveLength(6)

    titleReads = 0
    const extended = search(index, ['ze'])
    const extendedReads = titleReads
    titleReads = 0
    const word = search(index, ['zeb', '1'])
    const wordReads = titleReads

    // 20 zebras, each read at most once per term plus the exact and prefix checks.
    expect(extendedReads).toBeLessThanOrEqual(20 * 3)
    expect(wordReads).toBeLessThanOrEqual(20 * 4)
    titleReads = Number.NEGATIVE_INFINITY
    expect(extended).toEqual(searchSessionTitles(index, ['ze']))
    expect(word).toEqual(searchSessionTitles(index, ['zeb', '1']))
  })

  it('returns exactly what a full scan returns for every edit of a query', () => {
    const words = [
      'Alpha',
      'alpine',
      'ALP',
      'Chat',
      'chat log',
      'Ärger',
      'straße',
      'ＦＵＬＬ',
      'Beta',
    ]
    const providers = ['codex', 'grok', 'claude-code'] as const
    let seed = 7
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!
    const projectsFor = (count: number) =>
      Array.from({ length: 6 }, (_, projectIndex) => ({
        path: `/project-${projectIndex}`,
        sessions: Array.from({ length: count }, (_, sessionIndex) => ({
          id: `thread-${projectIndex}-${sessionIndex}`,
          title: `${pick(words)} ${pick(words)}${sessionIndex % 3 ? '' : ` ${sessionIndex}`}`,
          provider: pick(providers),
          // Repeated dates exercise the tie order.
          createdAt: Math.floor(random() * 40),
        })),
      }))
    // The tokenizer SessionSearch uses.
    const termsOf = (query: string) => [
      ...new Set(
        query
          .normalize('NFKC')
          .toLowerCase()
          .match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*/gu) ?? [],
      ),
    ]
    const typed = (text: string) => Array.from(text, (_, index) => text.slice(0, index + 1))
    const sequences: string[][] = [
      // Typing, including a query that matches more chats than the limit.
      typed('alpha'),
      typed('chat'),
      // Deleting characters one at a time, then typing again.
      [...typed('alpine'), 'alpin', 'alpi', 'alp', 'alpha', 'alph', 'al', ''],
      // Replacing the query, pasting, emptying.
      ['beta', 'alpha chat', 'alpha chat log', '', 'Chat Alpha', 'chat', 'c'],
      // Case and whitespace changes.
      ['alp', 'ALP', ' alp', 'alp ', 'al p', 'alp', 'alp  chat', 'ALP CHAT'],
      // A second word, then a word that contains an earlier one.
      ['al', 'al c', 'al ch', 'alchat', 'al chat', 'chat al'],
      // Folding: fullwidth letters, German letters.
      ['ｆ', 'fu', 'full', 'är', 'ärg', 'stra', 'straße', 'strasse'],
      // Numbers and repeated terms.
      ['1', '12', '1 1', '12 alpha', '3', '30', '303'],
    ]
    for (let sequence = 0; sequence < 40; sequence += 1) {
      const steps: string[] = []
      let query = ''
      for (let step = 0; step < 12; step += 1) {
        const action = random()
        if (action < 0.55) query += pick(['a', 'l', 'p', 'h', 'c', 't', ' ', 'A', '1', 'ß', 'ｃ'])
        else if (action < 0.75) query = query.slice(0, -1)
        else if (action < 0.85) query = pick(words)
        else if (action < 0.9) query = ''
        else query = `${query} ${pick(words)}`
        steps.push(query)
      }
      sequences.push(steps)
    }

    const indexes = [
      createSessionTitleIndex(projectsFor(40)),
      createSessionTitleIndex(projectsFor(5)),
    ]
    const optionSets: SessionTitleSearchOptions[] = [
      { limit: 6 },
      { limit: 2 },
      { limit: 500 },
      { projectPath: '/project-2', limit: 6 },
      { provider: 'grok', limit: 6 },
      { projectPath: '', limit: 6 },
    ]
    let compared = 0
    for (const options of optionSets) {
      const search = createSessionTitleSearcher()
      for (const [sequenceIndex, sequence] of sequences.entries()) {
        for (const [stepIndex, query] of sequence.entries()) {
          // Change the index and the filters mid-sequence as well.
          const index = indexes[(sequenceIndex + (stepIndex > 8 ? 1 : 0)) % 2]!
          const stepOptions = stepIndex === 5 ? { ...options, projectPath: '/project-1' } : options
          const terms = termsOf(query)
          const expected = searchSessionTitles(index, terms, stepOptions)
          const actual = search(index, terms, stepOptions)
          expect(actual, `${JSON.stringify(query)} ${JSON.stringify(stepOptions)}`).toEqual(
            expected,
          )
          expect(actual.every((entry, at) => entry === expected[at])).toBe(true)
          compared += 1
        }
      }
    }
    expect(compared).toBeGreaterThan(2_000)
  })
})
