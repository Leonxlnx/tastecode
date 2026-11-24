import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DomainEvent, ProviderHistorySession } from '@harness/contracts'
import {
  AUDITED_AGENT_SDK_VERSIONS,
  installedAgentSdkVersion,
  transcriptEvents,
} from './history.js'

// Counts the rows each read hands the Agent SDK, through its own session store.
const loaded = vi.hoisted(() => ({ calls: 0, rows: 0 }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (actual) => {
  const sdk = await actual<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...sdk,
    getSessionMessages: (
      id: string,
      options: Parameters<typeof sdk.getSessionMessages>[1] & {
        sessionStore: { load: (key: unknown) => Promise<unknown[]> }
      },
    ) => {
      loaded.calls++
      const store = options.sessionStore
      return sdk.getSessionMessages(id, {
        ...options,
        sessionStore: {
          ...store,
          load: async (key: unknown) => {
            const rows = await store.load(key)
            loaded.rows += rows.length
            return rows
          },
        },
      } as Parameters<typeof sdk.getSessionMessages>[1])
    },
  }
})

const SESSION = '33333333-3333-4333-8333-333333333333'
const AT = Date.parse('2026-11-20T10:00:00.000Z')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

let clock = 0
function row(
  uuid: string,
  type: string,
  content: unknown,
  parentUuid: string | null,
  extra: Record<string, unknown> = {},
) {
  clock++
  return {
    type,
    uuid,
    parentUuid,
    sessionId: SESSION,
    cwd: '/workspace',
    timestamp: new Date(AT + clock * 1000).toISOString(),
    message: {
      role: type,
      content,
      ...(type === 'assistant' ? { id: `msg-${uuid}`, stop_reason: 'end_turn' } : {}),
    },
    ...extra,
  }
}

const text = (value: string) => [{ type: 'text', text: value }]

/** A compaction as Claude Code 2.1 saves it: the kept rows are relinked after its summary. */
function compaction(id: string, logicalParent: string | undefined, preserved: string[]) {
  const summary = `${id}-summary`
  return [
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: id,
      parentUuid: null,
      ...(logicalParent ? { logicalParentUuid: logicalParent } : {}),
      sessionId: SESSION,
      timestamp: new Date(AT + ++clock * 1000).toISOString(),
      compactMetadata: {
        trigger: 'auto',
        preservedSegment: {
          headUuid: preserved[0],
          tailUuid: preserved.at(-1),
          anchorUuid: summary,
        },
        preservedMessages: { uuids: preserved, anchorUuid: summary },
      },
    },
    row(summary, 'user', 'Synthetic compact summary', id, { isCompactSummary: true }),
  ]
}

/** One prompt and its answer, continuing from `parent`. */
function exchange(id: string, parent: string | null, words = id) {
  return [
    row(`${id}-u`, 'user', `Prompt ${words}`, parent),
    row(`${id}-a`, 'assistant', text(`Answer ${words}`), `${id}-u`),
  ]
}

type ReadOptions = { lineEnd?: string; tail?: string; cuts?: boolean }

async function readOnce(rows: unknown[], options: ReadOptions = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-read-'))
  directories.push(dir)
  const file = path.join(dir, `${SESSION}.jsonl`)
  const lineEnd = options.lineEnd ?? '\n'
  await writeFile(
    file,
    rows
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)) + lineEnd)
      .join('') + (options.tail ?? ''),
  )
  const session: ProviderHistorySession = {
    id: SESSION,
    locator: file,
    revision: 'r',
    workspacePath: '/workspace',
    title: 'Fixture',
    createdAt: AT,
    updatedAt: AT,
  }
  return transcriptEvents(file, session, options.cuts === undefined ? {} : { cuts: options.cuts })
}

/**
 * The events read with cuts, after checking that they equal, in order and in every field,
 * the events of the read that hands the SDK every row before each compaction.
 */
async function read(rows: unknown[], options: ReadOptions = {}) {
  const full = await readOnce(rows, { ...options, cuts: false })
  const cut = await readOnce(rows, { ...options, cuts: true })
  expect(cut).toEqual(full)
  return cut
}

/** Every event, one line each: its type, the turn or item it is about, and what it shows. */
function lines(events: DomainEvent[]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case 'turn.started':
        return `turn ${event.turn.id.split(':')[1]} at ${event.turn.createdAt - AT}`
      case 'turn.completed':
        return `end ${event.status} at ${event.completedAt - AT}`
      case 'item.started':
      case 'item.completed': {
        const item = event.item
        const role = 'role' in item ? `:${String(item.role)}` : ''
        const shown = 'text' in item ? ` ${JSON.stringify(item.text)}` : ''
        return `${event.type === 'item.started' ? 'start' : 'item'} ${item.id} ${item.type}${role}${shown}`
      }
      case 'usage.updated':
        return `usage ${JSON.stringify(event.usage)}`
      default:
        return event.type
    }
  })
}

describe('reading a Claude Code transcript', () => {
  it('keeps every segment of a transcript compacted three times, in order, without summaries', async () => {
    clock = 0
    const events = await read([
      ...exchange('one', null),
      ...exchange('two', 'one-a'),
      ...compaction('c1', 'two-a', ['two-u', 'two-a']),
      ...exchange('three', 'c1-summary'),
      ...compaction('c2', 'three-a', ['three-u', 'three-a']),
      ...exchange('four', 'c2-summary'),
      ...exchange('five', 'four-a'),
      ...compaction('c3', 'five-a', ['five-a']),
      ...exchange('six', 'c3-summary'),
    ])
    expect(lines(events)).toMatchInlineSnapshot(`
      [
        "thread.started",
        "turn one-u at 1000",
        "item one-u message:user "Prompt one"",
        "item one-a:0 message:assistant "Answer one"",
        "end completed at 2000",
        "turn two-u at 3000",
        "item two-u message:user "Prompt two"",
        "item two-a:0 message:assistant "Answer two"",
        "end completed at 4000",
        "turn three-u at 7000",
        "item three-u message:user "Prompt three"",
        "item three-a:0 message:assistant "Answer three"",
        "end completed at 8000",
        "turn four-u at 11000",
        "item four-u message:user "Prompt four"",
        "item four-a:0 message:assistant "Answer four"",
        "end completed at 12000",
        "turn five-u at 13000",
        "item five-u message:user "Prompt five"",
        "item five-a:0 message:assistant "Answer five"",
        "end completed at 14000",
        "turn six-u at 17000",
        "item six-u message:user "Prompt six"",
        "item six-a:0 message:assistant "Answer six"",
        "end completed at 18000",
      ]
    `)
  })

  it('reads a compaction without a logical parent, or with one that is not saved, from the rows before it', async () => {
    clock = 0
    const events = await read([
      ...exchange('one', null),
      ...compaction('c1', undefined, ['one-a']),
      ...exchange('two', 'c1-summary'),
      ...compaction('c2', 'missing', ['two-u']),
      ...exchange('three', 'c2-summary'),
    ])
    expect(lines(events)).toMatchInlineSnapshot(`
      [
        "thread.started",
        "turn one-u at 1000",
        "item one-u message:user "Prompt one"",
        "item one-a:0 message:assistant "Answer one"",
        "end completed at 2000",
        "turn two-u at 5000",
        "item two-u message:user "Prompt two"",
        "item two-a:0 message:assistant "Answer two"",
        "end completed at 6000",
        "turn three-u at 9000",
        "item three-u message:user "Prompt three"",
        "item three-a:0 message:assistant "Answer three"",
        "end completed at 10000",
      ]
    `)
  })

  it('recovers parallel tool results and drops an abandoned branch after a compaction', async () => {
    clock = 0
    const tool = (id: string, parent: string, call: string) =>
      row(
        id,
        'assistant',
        [{ type: 'tool_use', id: call, name: 'Bash', input: { command: call } }],
        parent,
        {
          message: {
            id: 'shared-message',
            role: 'assistant',
            content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command: call } }],
          },
        },
      )
    const result = (id: string, parent: string, call: string) =>
      row(
        id,
        'user',
        [{ type: 'tool_result', tool_use_id: call, content: `${call} output` }],
        parent,
      )
    const events = await read([
      ...exchange('one', null),
      ...compaction('c1', 'one-a', ['one-a']),
      row('two-u', 'user', 'Run both', 'c1-summary'),
      tool('t1', 'two-u', 'first'),
      tool('t2', 't1', 'second'),
      result('r1', 't1', 'first'),
      result('r2', 't2', 'second'),
      row('old', 'assistant', text('Abandoned answer'), 'r2'),
      row('new', 'assistant', text('Current answer'), 'r2'),
    ])
    expect(lines(events)).toMatchInlineSnapshot(`
      [
        "thread.started",
        "turn one-u at 1000",
        "item one-u message:user "Prompt one"",
        "item one-a:0 message:assistant "Answer one"",
        "end completed at 2000",
        "turn two-u at 5000",
        "item two-u message:user "Run both"",
        "start t1:0 command",
        "start t2:0 command",
        "item t1:0 command "first output"",
        "item t2:0 command "second output"",
        "item new:0 message:assistant "Current answer"",
        "end completed at 11000",
      ]
    `)
  })

  it('follows a conversation rewound to before its last compaction', async () => {
    clock = 0
    const events = await read([
      ...exchange('one', null),
      ...exchange('two', 'one-a'),
      ...compaction('c1', 'two-a', ['two-a']),
      ...exchange('three', 'c1-summary'),
      ...compaction('c2', 'three-a', ['three-a']),
      ...exchange('four', 'c2-summary'),
      // Rewound to the first answer: the new prompt continues from before both compactions.
      ...exchange('rewound', 'one-a'),
    ])
    expect(lines(events)).toMatchInlineSnapshot(`
      [
        "thread.started",
        "turn one-u at 1000",
        "item one-u message:user "Prompt one"",
        "item one-a:0 message:assistant "Answer one"",
        "end completed at 2000",
        "turn rewound-u at 13000",
        "item rewound-u message:user "Prompt rewound"",
        "item rewound-a:0 message:assistant "Answer rewound"",
        "end completed at 14000",
      ]
    `)
  })

  it('leaves out sidechain and team rows, also where they share ids with the main chain', async () => {
    clock = 0
    const events = await read([
      ...exchange('one', null),
      row('side-1', 'assistant', text('Subagent says'), 'one-a', { isSidechain: true }),
      ...compaction('c1', 'one-a', ['one-a']),
      row('team-1', 'user', 'Teammate prompt', 'c1-summary', { teamName: 'crew' }),
      ...exchange('two', 'c1-summary'),
      row('side-2', 'assistant', text('Subagent again'), 'two-a', {
        isSidechain: true,
        message: { id: 'msg-one-a', role: 'assistant', content: text('Subagent again') },
      }),
    ])
    expect(lines(events)).toMatchInlineSnapshot(`
      [
        "thread.started",
        "turn one-u at 1000",
        "item one-u message:user "Prompt one"",
        "item one-a:0 message:assistant "Answer one"",
        "end completed at 2000",
        "turn two-u at 7000",
        "item two-u message:user "Prompt two"",
        "item two-a:0 message:assistant "Answer two"",
        "end completed at 8000",
      ]
    `)
  })

  it('reads CRLF line ends, unknown and untyped rows, bad JSON and a torn last line', async () => {
    clock = 0
    const rows = [
      ...exchange('one', null),
      { type: 'frame-link', uuid: 'frame', parentUuid: 'one-a', sessionId: SESSION },
      { uuid: 'untyped', parentUuid: 'one-a' },
      '["not", "a", "row"]',
      '{"type": "user", "uuid": "broken"',
      '',
      ...compaction('c1', 'one-a', ['one-a']),
      ...exchange('two', 'c1-summary'),
    ]
    const torn = JSON.stringify(row('torn', 'user', 'Half written', 'two-a')).slice(0, 40)
    const lf = await read(rows, { tail: torn })
    const crlf = await read(rows, { lineEnd: '\r\n', tail: torn })
    expect(crlf).toEqual(lf)
    // A lone CR ends a line as well, and a CR before CRLF leaves an empty line.
    expect(await read(rows, { lineEnd: '\r', tail: torn })).toEqual(lf)
    expect(await read(rows, { lineEnd: '\r\r\n', tail: torn })).toEqual(lf)
    // Rows longer than a read chunk, split by multi-byte characters.
    const long = [
      row('long-u', 'user', `Prompt ${'ü€'.repeat(700_000)}`, null),
      row('long-a', 'assistant', text(`Answer ${'𝄞'.repeat(600_000)}`), 'long-u'),
    ]
    const shown = (await read(long, { lineEnd: '\r\n' })).flatMap((event) =>
      event.type === 'item.completed' && 'text' in event.item ? [event.item.text] : [],
    )
    expect(shown).toEqual([`Prompt ${'ü€'.repeat(700_000)}`, `Answer ${'𝄞'.repeat(600_000)}`])
    expect(lines(lf)).toMatchInlineSnapshot(`
      [
        "thread.started",
        "turn one-u at 1000",
        "item one-u message:user "Prompt one"",
        "item one-a:0 message:assistant "Answer one"",
        "end completed at 2000",
        "turn two-u at 5000",
        "item two-u message:user "Prompt two"",
        "item two-a:0 message:assistant "Answer two"",
        "end completed at 6000",
      ]
    `)
  })

  it('reads rows that refer across a compaction the same as the rows before it would', async () => {
    clock = 0
    const events = await read([
      ...exchange('one', null),
      ...exchange('two', 'one-a'),
      ...compaction('c1', 'two-a', ['two-a']),
      row('three-u', 'user', 'Prompt three', 'c1-summary'),
      // The same API message as an answer before the compaction.
      row('three-a', 'assistant', text('Answer three'), 'three-u', {
        message: { id: 'msg-one-a', role: 'assistant', content: text('Answer three') },
      }),
      ...compaction('c2', 'three-a', ['three-a']),
      // A tool call whose result was saved before the compaction.
      row(
        'four-u',
        'user',
        [{ type: 'tool_result', tool_use_id: 'early', content: 'late' }],
        'c2-summary',
      ),
      ...exchange('five', 'four-u'),
    ])
    expect(lines(events)).toMatchInlineSnapshot(`
      [
        "thread.started",
        "turn one-u at 1000",
        "item one-u message:user "Prompt one"",
        "item one-a:0 message:assistant "Answer one"",
        "end completed at 2000",
        "turn two-u at 3000",
        "item two-u message:user "Prompt two"",
        "item two-a:0 message:assistant "Answer two"",
        "end completed at 4000",
        "turn three-u at 7000",
        "item three-u message:user "Prompt three"",
        "item three-a:0 message:assistant "Answer three"",
        "item four-u:0 tool_call "late"",
        "end interrupted at 11000",
        "turn five-u at 12000",
        "item five-u message:user "Prompt five"",
        "item five-a:0 message:assistant "Answer five"",
        "end completed at 13000",
      ]
    `)
  })

  it('hands the SDK each compacted segment once instead of every row before it', async () => {
    clock = 0
    const rows: unknown[] = [...exchange('s0', null)]
    let last = 's0-a'
    for (let segment = 1; segment <= 8; segment++) {
      rows.push(...compaction(`c${segment}`, last, [last]))
      let parent = `c${segment}-summary`
      for (let turn = 0; turn < 10; turn++) {
        rows.push(...exchange(`s${segment}-${turn}`, parent))
        parent = `s${segment}-${turn}-a`
      }
      last = parent
    }
    loaded.calls = 0
    loaded.rows = 0
    const events = await readOnce(rows)
    expect(loaded.calls).toBe(9)
    // Each segment and the rows its compaction kept; every row before each compaction, as
    // the SDK used to be handed, is 810.
    expect(loaded.rows).toBeLessThan(rows.length + 3 * 8)
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(81)
  })
})

/** Rows as saved, in file order, each one second after the one before. */
function saved(rows: Array<Record<string, unknown>>) {
  return rows.map((item) => ({
    sessionId: SESSION,
    timestamp: new Date(AT + ++clock * 1000).toISOString(),
    ...item,
  }))
}

const texts = (events: DomainEvent[]) =>
  events.flatMap((event) =>
    event.type === 'item.completed' && 'text' in event.item ? [event.item.text] : [],
  )

describe('reading a transcript the cut cannot cover', () => {
  it('reads ids with a line feed whole, where SDK keys of parent and id could collide', async () => {
    clock = 0
    const events = await read(
      saved([
        {
          type: 'user',
          uuid: 'c',
          parentUuid: 'a\nb',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'old', content: 'orphan' }],
          },
        },
        { type: 'system', subtype: 'compact_boundary', uuid: 'K', parentUuid: null },
        { type: 'user', uuid: 'U', parentUuid: 'K', message: { role: 'user', content: 'Run it' } },
        {
          type: 'assistant',
          uuid: 'a',
          parentUuid: 'U',
          message: {
            id: 'm',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'T', name: 'Bash', input: { command: 'echo result' } },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'b\nc',
          parentUuid: 'a',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'T', content: 'only result' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'Z',
          parentUuid: 'a',
          message: {
            id: 'z',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done' }],
          },
        },
      ]),
    )
    expect(texts(events)).not.toContain('only result')
    expect(texts(events)).toContain('Done')
  })

  it('fails a parent that is not a string as the full read does', async () => {
    clock = 0
    const rows = saved([
      {
        type: 'user',
        uuid: 'r',
        parentUuid: { toString: 0 },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'old', content: 'orphan' }],
        },
      },
      { type: 'system', subtype: 'compact_boundary', uuid: 'K', parentUuid: null },
      {
        type: 'assistant',
        uuid: 'A',
        parentUuid: null,
        message: { id: 'm', role: 'assistant', content: text('Answer') },
      },
    ])
    const full = await readOnce(rows, { cuts: false }).then(
      () => 'read',
      (error: Error) => error.message,
    )
    expect(full).not.toBe('read')
    await expect(readOnce(rows, { cuts: true })).rejects.toThrow(full)
  })

  it.each([
    ['an id that is not a string', { uuid: { toString: null } }],
    ['no id', {}],
  ])('reads past a compaction with %s as the full read does', async (_name, id) => {
    clock = 0
    const events = await read(
      saved([
        { type: 'user', uuid: 'U', parentUuid: null, message: { role: 'user', content: 'Ask' } },
        { type: 'system', subtype: 'compact_boundary', parentUuid: null, ...id },
        {
          type: 'assistant',
          uuid: 'A',
          parentUuid: 'U',
          message: { id: 'm', role: 'assistant', content: text('Answer') },
        },
      ]),
    )
    expect(texts(events)).toEqual(['Ask', 'Answer'])
  })
})

describe('the Agent SDK the cut was checked against', () => {
  it('is the installed one', () => {
    // A new SDK version can compare rows in ways `references` does not list: check `cutter`
    // in history.ts against its session read, then add the version.
    expect(
      AUDITED_AGENT_SDK_VERSIONS,
      `@anthropic-ai/claude-agent-sdk ${installedAgentSdkVersion()} was not audited`,
    ).toContain(installedAgentSdkVersion())
  })

  it('reads every row before each compaction when cuts are off', async () => {
    clock = 0
    const rows: unknown[] = [...exchange('s0', null)]
    let last = 's0-a'
    for (let segment = 1; segment <= 8; segment++) {
      rows.push(...compaction(`c${segment}`, last, [last]))
      let parent = `c${segment}-summary`
      for (let turn = 0; turn < 10; turn++) {
        rows.push(...exchange(`s${segment}-${turn}`, parent))
        parent = `s${segment}-${turn}-a`
      }
      last = parent
    }
    loaded.calls = 0
    loaded.rows = 0
    await readOnce(rows, { cuts: false })
    expect([loaded.calls, loaded.rows]).toEqual([9, 810])
  })

  it('reads siblings, deliveries and tool ids shared across a compaction as the full read does', async () => {
    clock = 0
    const queued = (id: string, parent: string, delivery: string, source: string) => ({
      type: 'attachment',
      uuid: id,
      parentUuid: parent,
      attachment: {
        type: 'queued_command',
        prompt: `Queued ${id}`,
        delivery_id: delivery,
        source_uuid: source,
      },
    })
    const tool = (id: string, parent: string, message: string, call: string) => ({
      type: 'assistant',
      uuid: id,
      parentUuid: parent,
      message: {
        id: message,
        role: 'assistant',
        content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command: call } }],
      },
    })
    const result = (id: string, parent: string, call: string) => ({
      type: 'user',
      uuid: id,
      parentUuid: parent,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: call, content: `${call} by ${id}` }],
      },
    })
    const events = await read(
      saved([
        { type: 'user', uuid: 'P', parentUuid: null, message: { role: 'user', content: 'Go' } },
        // Before the compaction: E calls T under API message e.
        tool('E', 'P', 'e', 'T'),
        result('E-r', 'E', 'T'),
        queued('Q1', 'E-r', 'd1', 'P'),
        {
          type: 'queue-operation',
          operation: 'remove',
          reason: 'absorbed_mid_turn',
          deliveryId: 'd2',
        },
        {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'K',
          parentUuid: null,
          logicalParentUuid: 'E-r',
        },
        { type: 'user', uuid: 'U', parentUuid: 'K', message: { role: 'user', content: 'Again' } },
        // After it: A calls T as well, under another API message, beside a parallel call.
        tool('A', 'U', 'a', 'T'),
        tool('A2', 'A', 'a', 'T2'),
        result('A2-r', 'A2', 'T2'),
        // A result for T whose parent was never saved.
        result('R', 'missing', 'T'),
        queued('Q2', 'A2-r', 'd2', 'U'),
        {
          type: 'assistant',
          uuid: 'Z',
          parentUuid: 'A',
          message: { id: 'z', role: 'assistant', stop_reason: 'end_turn', content: text('Done') },
        },
      ]),
    )
    expect(texts(events)).toContain('Done')
  })

  it('reads a cut moved back past every limit as the full read does', async () => {
    clock = 0
    // Each retreat exposes another parent before it, more often than a cut moves back.
    const rows: Array<Record<string, unknown>> = []
    let parent: string | null = null
    for (let index = 0; index < 12; index++) {
      const role = index % 2 ? 'assistant' : 'user'
      rows.push({
        type: role,
        uuid: `p${index}`,
        parentUuid: parent,
        message: { id: `m${index}`, role, content: `Row ${index}` },
      })
      parent = `p${index}`
    }
    rows.push({ type: 'system', subtype: 'compact_boundary', uuid: 'K', parentUuid: parent })
    rows.push({
      type: 'user',
      uuid: 'U',
      parentUuid: 'K',
      message: { role: 'user', content: 'Last' },
    })
    const events = await read(saved(rows))
    expect(texts(events).at(-1)).toBe('Last')
  })
})
