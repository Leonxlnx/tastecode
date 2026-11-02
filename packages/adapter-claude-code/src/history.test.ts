import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DomainEventSchema,
  type ApprovalMode,
  type DomainEvent,
  type ProviderHistoryListOptions,
  type ProviderHistorySession,
} from '@harness/contracts'
import { canCreateSymlinks } from '@harness/proc/symlink.test-support'
import { createClaudeHistorySource } from './history.js'

const canSymlink = canCreateSymlinks()

const SESSION = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const AT = Date.parse('2026-09-15T10:00:00.000Z')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function row(
  uuid: string,
  type: string,
  content: unknown,
  parentUuid: string | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    uuid,
    parentUuid,
    sessionId: SESSION,
    cwd: path.join(os.tmpdir(), 'claude-workspace'),
    timestamp: new Date(AT).toISOString(),
    message: { role: type, content },
    ...extra,
  }
}

async function fixture(rows: unknown[], id = SESSION) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-history-'))
  directories.push(configDir)
  const project = path.join(configDir, 'projects', '-fixture')
  await mkdir(project, { recursive: true })
  const file = path.join(project, `${id}.jsonl`)
  await writeFile(file, rows.map((item) => JSON.stringify(item)).join('\n') + '\n')
  const source = createClaudeHistorySource({ configDir })
  return { configDir, project, file, source }
}

function items(events: DomainEvent[]) {
  return events.flatMap((event) => (event.type === 'item.completed' ? [event.item] : []))
}

const MODE_ACCESS = Object.entries({
  default: 'ask',
  acceptEdits: 'auto',
  auto: 'auto-review',
  bypassPermissions: 'full',
  plan: undefined,
} satisfies Record<string, ApprovalMode | undefined>)

function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A transcript of every row kind a listing reads or skips, some of them longer than a
 * read chunk, and the session it should list as. `more` appends rows and updates it.
 */
function transcript(random: () => number) {
  const start = AT + 9e12
  const later = (step: number) => new Date(start + step * 1000).toISOString()
  const first = row('first', 'user', 'Generated prompt', null, { timestamp: later(0) })
  const expected: Pick<
    ProviderHistorySession,
    'title' | 'named' | 'workspacePath' | 'createdAt' | 'updatedAt' | 'approval'
  > = {
    title: 'Generated prompt',
    workspacePath: first.cwd,
    createdAt: start,
    updatedAt: start,
  }
  let customTitle: string | undefined
  let aiTitle: string | undefined
  let step = 0
  const more = (count: number) => {
    const rows: unknown[] = []
    for (let index = 0; index < count; index++) {
      step++
      const big = random() < 0.1
      const pad = 'x'.repeat(Math.floor(random() * (big ? 1_200_000 : 2_000)) + (big ? 100_000 : 0))
      const hidden = random() < 0.3 ? { isSidechain: true } : {}
      const kind = Math.floor(random() * 8)
      if (kind === 0) {
        rows.push(row(`a${step}`, 'assistant', pad, null, { timestamp: later(step) }))
        expected.updatedAt = start + step * 1000
      } else if (kind === 1) {
        rows.push(row(`s${step}`, 'assistant', pad, null, { ...hidden, isMeta: true }))
      } else if (kind === 2) {
        const title = { type: 'ai-title', sessionId: SESSION, aiTitle: `AI ${step}`, ...hidden }
        rows.push(random() < 0.5 ? { pad, ...title } : { ...title, pad })
        if (!('isSidechain' in hidden)) aiTitle = title.aiTitle
      } else if (kind === 3) {
        const title = { type: 'custom-title', sessionId: SESSION, customTitle: `Named ${step}` }
        rows.push({ ...title, ...hidden })
        if (!('isSidechain' in hidden)) customTitle = title.customTitle
      } else if (kind === 4) {
        const relocatedCwd = path.join(os.tmpdir(), `claude-moved-${step}`)
        rows.push({ type: 'relocated', sessionId: SESSION, relocatedCwd, pad, ...hidden })
        if (!('isSidechain' in hidden)) expected.workspacePath = relocatedCwd
      } else if (kind === 5) {
        rows.push(
          row(`side${step}`, 'user', pad, null, { isSidechain: true, timestamp: later(1e6) }),
        )
      } else if (kind === 6) {
        rows.push({ type: 'system', subtype: 'informational', content: pad })
      } else {
        const [permissionMode, approval] = MODE_ACCESS[Math.floor(random() * MODE_ACCESS.length)]!
        const prompt = random() < 0.5
        rows.push(
          prompt
            ? row(`p${step}`, 'user', pad, null, {
                permissionMode,
                timestamp: later(step),
                ...hidden,
              })
            : { type: 'permission-mode', permissionMode, sessionId: SESSION, ...hidden },
        )
        if (!('isSidechain' in hidden)) {
          if (prompt) expected.updatedAt = start + step * 1000
          if (approval) expected.approval = approval
        }
      }
      expected.title = customTitle ?? aiTitle ?? 'Generated prompt'
      if (customTitle ?? aiTitle) expected.named = true
    }
    return rows
  }
  return { first, expected, more }
}

describe('Claude Code saved history', () => {
  it('maps legacy TasteCode thread IDs to native session IDs', () => {
    const source = createClaudeHistorySource()
    expect(source.resolveSessionId?.('claude-11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    )
    expect(source.resolveSessionId?.('11111111-1111-4111-8111-111111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111111',
    )
  })
  it('finds sessions without an index, respects native titles and timestamps, and notices updates', async () => {
    const f = await fixture([
      row('u1', 'user', 'First **prompt**'),
      { type: 'ai-title', sessionId: SESSION, aiTitle: 'Native title' },
    ])
    await writeFile(
      path.join(f.project, 'sessions-index.json'),
      JSON.stringify({
        entries: [
          { sessionId: SECOND, firstPrompt: 'Stale missing file', projectPath: '/missing' },
        ],
      }),
    )
    const first = await f.source.list()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      id: SESSION,
      title: 'Native title',
      named: true,
      createdAt: AT,
    })
    const before = await readFile(f.file, 'utf8')
    const info = await stat(f.file)
    await f.source.read(first[0]!)
    expect(await readFile(f.file, 'utf8')).toBe(before)
    expect((await stat(f.file)).mtimeMs).toBe(info.mtimeMs)
    await appendFile(
      f.file,
      JSON.stringify({ type: 'custom-title', customTitle: 'Renamed', sessionId: SESSION }) + '\n',
    )
    const next = await f.source.list()
    expect(next[0]?.title).toBe('Renamed')
    expect(next[0]?.revision).not.toBe(first[0]?.revision)
  })

  it('lists a long transcript from its first, last and title rows only', async () => {
    const at = (second: number) => new Date(AT + second * 1000).toISOString()
    const moved = path.join(os.tmpdir(), 'claude-moved')
    const rows: unknown[] = [
      row('meta', 'user', 'Caveat: local command', null, { isMeta: true, timestamp: at(0) }),
      row('prompt', 'user', 'Fix the build', 'meta', { timestamp: at(1) }),
    ]
    for (let turn = 0; turn < 200; turn++) {
      rows.push(
        row(
          `a${turn}`,
          'assistant',
          [{ type: 'text', text: 'Rename "customTitle" later.' }],
          null,
          {
            timestamp: at(turn + 2),
          },
        ),
      )
      if (turn === 50) rows.push({ type: 'ai-title', sessionId: SESSION, aiTitle: 'Build fix' })
      if (turn === 80) rows.push({ type: 'relocated', sessionId: SESSION, relocatedCwd: moved })
    }
    rows.push(
      { type: 'custom-title', sessionId: SESSION, customTitle: 'Subagent', isSidechain: true },
      row('side', 'assistant', 'Subagent reply', null, { isSidechain: true, timestamp: at(900) }),
    )
    const f = await fixture(rows)
    const parse = vi.spyOn(JSON, 'parse')

    const [session] = await f.source.list()

    expect(parse.mock.calls.length).toBeLessThan(10)
    parse.mockRestore()
    expect(session).toMatchObject({
      title: 'Build fix',
      workspacePath: moved,
      createdAt: AT + 1000,
    })
    expect(session?.updatedAt).toBe(Math.max((await stat(f.file)).mtimeMs, AT + 201_000))
  })

  it.each(['customTitle', 'aiTitle'])(
    'finds a %s row wherever it falls across the scan chunks',
    async (key) => {
      const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-history-'))
      directories.push(configDir)
      const project = path.join(configDir, 'projects', '-fixture')
      await mkdir(project, { recursive: true })
      const head = [
        row('meta', 'user', 'Caveat', null, { isMeta: true }),
        row('p', 'user', 'Edges'),
      ]
        .map((item) => JSON.stringify(item) + '\n')
        .join('')
      const filler = (length: number) =>
        JSON.stringify(row('f', 'assistant', 'x'.repeat(length), null, { isSidechain: true })) +
        '\n'
      // Token scans read 1 MB chunks from the end of the head and carry 12 bytes over, one
      // less than the longest token.
      const boundary = Buffer.byteLength(head) + 1024 * 1024
      const offsets = [0, 1, 3, 6, 7, 8, 12, 13, 14]
      for (const [index, back] of offsets.entries()) {
        const id = `00000000-0000-4000-8000-00000000000${index}`
        const type = key === 'customTitle' ? 'custom-title' : 'ai-title'
        const title = JSON.stringify({ type, sessionId: id, [key]: `E${back}` })
        const before = boundary - back - title.indexOf(`"${key}"`)
        const pad = before - Buffer.byteLength(head) - Buffer.byteLength(filler(0))
        const text = Buffer.from(head + filler(pad) + title + '\n' + filler(10))
        expect(text.indexOf(`"${key}"`)).toBe(boundary - back)
        await writeFile(path.join(project, `${id}.jsonl`), text)
      }
      const sessions = await createClaudeHistorySource({ configDir }).list()
      expect(sessions.map((session) => session.title).sort()).toEqual(
        offsets.map((back) => `E${back}`).sort(),
      )
    },
  )

  it('takes no other key that ends in Title for a title row', async () => {
    const f = await fixture([
      row('u1', 'user', 'First prompt'),
      { type: 'page', sessionId: SESSION, pageTitle: 'Not a session title' },
      { type: 'note', sessionId: SESSION, subTitle: 'Neither', aiTitles: ['nor this'] },
      row('a1', 'assistant', 'Quoted "aiTitle" and "customTitle" in text are not keys.'),
    ])

    const [session] = await f.source.list()

    expect(session?.title).toBe('First prompt')
    // The first prompt stands in for a name; it is not one.
    expect(session?.named).toBeUndefined()
  })

  it('lists the access level the session last ran with', async () => {
    const mode = (permissionMode: string) => ({
      type: 'permission-mode',
      permissionMode,
      sessionId: SESSION,
    })
    const prompt = (uuid: string, permissionMode: string, extra: Record<string, unknown> = {}) =>
      row(uuid, 'user', `Prompt ${uuid}`, null, { permissionMode, ...extra })
    const lines = (rows: unknown[]) => rows.map((item) => JSON.stringify(item) + '\n').join('')
    const f = await fixture([mode('bypassPermissions'), prompt('u1', 'bypassPermissions')])
    const fresh = () => createClaudeHistorySource({ configDir: f.configDir }).list()
    const approval = async () => {
      const [session] = await f.source.list()
      expect([session]).toEqual(await fresh())
      return session?.approval
    }
    expect(await approval()).toBe('full')

    // A later prompt counts, not a subagent's own prompt after it.
    await appendFile(
      f.file,
      lines([
        prompt('u2', 'acceptEdits'),
        row('a2', 'assistant', 'x'.repeat(200_000)),
        prompt('side', 'default', { isSidechain: true }),
        row('a3', 'assistant', 'Still working'),
      ]),
    )
    expect(await approval()).toBe('auto')

    // Plan mode is no access level; a change of mode after the last answer is.
    await appendFile(f.file, lines([prompt('u3', 'plan'), row('a4', 'assistant', 'Planned')]))
    expect(await approval()).toBe('auto')
    await appendFile(f.file, lines([mode('auto')]))
    expect(await approval()).toBe('auto-review')

    const unknown = await fixture([
      row('u1', 'user', 'No mode saved'),
      row('a1', 'assistant', 'Hi'),
    ])
    expect((await unknown.source.list())[0]).not.toHaveProperty('approval')
  })

  it('lists generated transcripts as their rows say', async () => {
    const random = seeded(1016)
    for (let round = 0; round < 4; round++) {
      const generated = transcript(random)
      const f = await fixture([generated.first, ...generated.more(60)])
      if (random() < 0.5) await appendFile(f.file, '{"type":"assistant","message":{"content":"to')
      const [session] = await f.source.list()
      expect(session).toMatchObject(generated.expected)
    }
  })

  it('continues a growing transcript and lists it as a fresh read would', async () => {
    const random = seeded(1017)
    for (let round = 0; round < 3; round++) {
      const generated = transcript(random)
      // Rows without a working directory or a prompt keep the head open across appends.
      const early = round
        ? []
        : [
            row('meta', 'user', 'Caveat', null, { isMeta: true }),
            { ...row('a0', 'assistant', 'Before the prompt'), cwd: undefined },
          ]
      const f = await fixture(early)
      const fresh = () => createClaudeHistorySource({ configDir: f.configDir }).list()
      let written = ''
      let flushed = 0
      for (let step = 0; step < 8; step++) {
        const rows = step === (round ? 0 : 2) ? [generated.first] : []
        rows.push(...generated.more(3))
        written += rows.map((item) => JSON.stringify(item) + '\n').join('')
        // A writer can be caught between two writes of one row.
        const cut =
          random() < 0.4
            ? flushed + Math.floor(random() * (written.length - flushed))
            : written.length
        await appendFile(f.file, written.slice(flushed, cut))
        flushed = cut
        const listed = await f.source.list()
        expect(listed).toEqual(await fresh())
        if (round && flushed === written.length) expect(listed[0]).toMatchObject(generated.expected)
      }
    }
  })

  it('reads only what was appended to a long transcript', async () => {
    const f = await fixture([
      row('u1', 'user', 'Long work'),
      ...Array.from({ length: 30 }, (_, index) =>
        row(`a${index}`, 'assistant', 'x'.repeat(100_000), 'u1'),
      ),
    ])
    await f.source.list()
    const probe = await open(f.file, 'r')
    const read = vi.spyOn(Object.getPrototypeOf(probe), 'read')
    await probe.close()
    try {
      await appendFile(
        f.file,
        JSON.stringify({ type: 'ai-title', sessionId: SESSION, aiTitle: 'Appended' }) +
          '\n' +
          JSON.stringify(row('a-last', 'assistant', 'Short', 'u1')) +
          '\n',
      )
      read.mockClear()
      const [session] = await f.source.list()
      const requested = read.mock.calls.reduce((sum, call) => sum + Number(call[2] ?? 0), 0)
      expect(session?.title).toBe('Appended')
      expect(requested).toBeLessThan(100_000)
      expect((await stat(f.file)).size).toBeGreaterThan(3_000_000)
    } finally {
      read.mockRestore()
    }
  })

  it('reads a transcript from the start again when it shrank or its last rows changed', async () => {
    const prompt = row('u1', 'user', `Rewrite ${'p'.repeat(5_000)}`)
    const title = (text: string) => ({ type: 'ai-title', sessionId: SESSION, aiTitle: text })
    const f = await fixture([prompt, title('Old'), row('a1', 'assistant', 'Old answer', 'u1')])
    const fresh = () => createClaudeHistorySource({ configDir: f.configDir }).list()
    expect((await f.source.list())[0]?.title).toBe('Old')
    // Same first bytes, a title rewritten in place, and different bytes before the old end.
    await writeFile(
      f.file,
      [prompt, title('New'), row('a1', 'assistant', 'New answer', 'u1'), row('a2', 'user', 'More')]
        .map((item) => JSON.stringify(item) + '\n')
        .join(''),
    )
    expect((await f.source.list())[0]?.title).toBe('New')
    expect(await f.source.list()).toEqual(await fresh())
    await writeFile(f.file, JSON.stringify(prompt) + '\n')
    expect((await f.source.list())[0]?.title).toBe(`Rewrite ${'p'.repeat(5_000)}`.slice(0, 200))
    expect(await f.source.list()).toEqual(await fresh())
  })

  it('lists from the metadata a server kept across a restart without reading transcripts', async () => {
    const f = await fixture([row('u1', 'user', 'Kept'), row('a1', 'assistant', 'Answer', 'u1')])
    const empty = path.join(f.project, `${SECOND}.jsonl`)
    await writeFile(
      empty,
      JSON.stringify(row('m1', 'user', 'Caveat', null, { isMeta: true })) + '\n',
    )
    // What the server's metadata table would hold, and which locators a listing named.
    const kept = new Map<string, { revision: string; session: ProviderHistorySession | null }>()
    const named = new Set<string>()
    const options: ProviderHistoryListOptions = {
      cached: (locator, revision) => {
        named.add(locator)
        const entry = kept.get(locator)
        return entry?.revision === revision ? entry.session : undefined
      },
      remember: (locator, revision, session) => {
        named.add(locator)
        kept.set(locator, { revision, session })
      },
    }
    const listed = await f.source.list(options)
    expect(listed).toEqual(await createClaudeHistorySource({ configDir: f.configDir }).list())
    expect(kept.get(f.file)?.session).toEqual(listed[0])
    expect(kept.get(empty)?.session).toBeNull()

    const restarted = createClaudeHistorySource({ configDir: f.configDir })
    const probe = await open(f.file, 'r')
    const read = vi.spyOn(Object.getPrototypeOf(probe), 'read')
    await probe.close()
    try {
      read.mockClear()
      expect(await restarted.list(options)).toEqual(listed)
      expect(read).not.toHaveBeenCalled()
      // Unchanged transcripts are still named, so the server keeps their rows.
      named.clear()
      await restarted.list(options)
      expect([...named].sort()).toEqual([f.file, empty].sort())
      expect(read).not.toHaveBeenCalled()

      // After another restart, a transcript that grew and a kept row naming another
      // session are read again.
      await appendFile(f.file, JSON.stringify(row('a2', 'assistant', 'More', 'a1')) + '\n')
      const entry = kept.get(empty)!
      kept.set(empty, { ...entry, session: { ...listed[0]!, locator: empty } })
      const fresh = await createClaudeHistorySource({ configDir: f.configDir }).list()
      read.mockClear()
      expect(await createClaudeHistorySource({ configDir: f.configDir }).list(options)).toEqual(
        fresh,
      )
      expect(read).toHaveBeenCalled()
      expect(kept.get(f.file)?.session).toEqual(fresh[0])
      expect(kept.get(empty)?.session).toBeNull()
    } finally {
      read.mockRestore()
    }
  })

  it('lists a session again when its sessions index entry changes', async () => {
    const f = await fixture([row('u1', 'user', 'Prompt'), row('a1', 'assistant', 'Answer', 'u1')])
    const index = (summary: string) =>
      writeFile(
        path.join(f.project, 'sessions-index.json'),
        JSON.stringify({ entries: [{ sessionId: SESSION, summary }] }),
      )
    await index('First summary')
    const kept = new Map<string, { revision: string; session: ProviderHistorySession | null }>()
    const options: ProviderHistoryListOptions = {
      cached: (locator, revision) => {
        const entry = kept.get(locator)
        return entry?.revision === revision ? entry.session : undefined
      },
      remember: (locator, revision, session) => kept.set(locator, { revision, session }),
    }
    expect((await f.source.list(options))[0]).toMatchObject({
      title: 'First summary',
      named: true,
    })
    await index('Second summary')
    expect((await f.source.list(options))[0]?.title).toBe('Second summary')
    const restarted = createClaudeHistorySource({ configDir: f.configDir })
    expect((await restarted.list(options))[0]?.title).toBe('Second summary')
  })

  it('reads rows longer than a chunk at the head, around a title and at the tail', async () => {
    const at = (second: number) => new Date(AT + second * 1000).toISOString()
    const moved = path.join(os.tmpdir(), 'claude-long-moved')
    const prompt = `Long ${'p'.repeat(200_000)}`
    const f = await fixture([
      row('prompt', 'user', prompt, null, { timestamp: at(1) }),
      // The token sits 2.5 MB into its row, and the next row's token 2.5 MB before its end.
      { padding: 'x'.repeat(2_500_000), type: 'ai-title', sessionId: SESSION, aiTitle: 'Far' },
      {
        type: 'relocated',
        sessionId: SESSION,
        relocatedCwd: moved,
        padding: 'y'.repeat(2_500_000),
      },
      row('last', 'assistant', 'z'.repeat(300_000), null, { timestamp: at(9_000_000_000) }),
      row('meta', 'user', 'Caveat', null, { isMeta: true, timestamp: at(9_000_000_001) }),
      row('side', 'assistant', 'Subagent', null, {
        isSidechain: true,
        timestamp: at(9_000_000_002),
      }),
    ])
    const [session] = await f.source.list()
    expect(session).toMatchObject({
      title: 'Far',
      workspacePath: moved,
      createdAt: AT + 1000,
      updatedAt: AT + 9_000_000_000_000,
    })
  })

  it('counts a final row without its line feed and skips a torn one', async () => {
    const later = new Date(AT + 9_000_000_000_000).toISOString()
    const f = await fixture([row('u1', 'user', 'Whole')])
    await appendFile(
      f.file,
      JSON.stringify(row('a1', 'assistant', 'Done', 'u1', { timestamp: later })),
    )
    await writeFile(
      path.join(f.project, `${SECOND}.jsonl`),
      JSON.stringify(row('u2', 'user', 'Torn', null, { sessionId: SECOND })) +
        '\n' +
        JSON.stringify({ type: 'ai-title', sessionId: SECOND, aiTitle: 'Torn title' }).slice(0, -5),
    )
    const sessions = await f.source.list()
    expect(sessions.find((session) => session.id === SESSION)?.updatedAt).toBe(
      AT + 9_000_000_000_000,
    )
    expect(sessions.find((session) => session.id === SECOND)?.title).toBe('Torn')
  })

  it('preserves Markdown, reasoning, attachments, typed tool output, native times, and distinct turns', async () => {
    const prompt = '  Keep whitespace\n\n```ts\nconst x = 1\n```\n'
    const answer = '## Done\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    const f = await fixture([
      row('u1', 'user', [
        { type: 'text', text: prompt },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ]),
      row(
        'a1',
        'assistant',
        [
          { type: 'thinking', thinking: '  Think\n' },
          { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'node --version' } },
        ],
        'u1',
        {
          message: {
            id: 'msg1',
            content: [
              { type: 'thinking', thinking: '  Think\n' },
              { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'node --version' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ),
      row(
        'r1',
        'user',
        [{ type: 'tool_result', tool_use_id: 'tool1', content: '  v22\n', is_error: true }],
        'a1',
        {
          toolUseResult: { code: 1, durationMs: 12 },
          timestamp: new Date(AT + 1000).toISOString(),
        },
      ),
      row('a2', 'assistant', [], 'r1', {
        message: { id: 'msg2', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' },
        timestamp: new Date(AT + 2000).toISOString(),
      }),
      row('u2', 'user', 'Second prompt', 'a2', { timestamp: new Date(AT + 3000).toISOString() }),
    ])
    const session = (await f.source.list())[0]!
    const events = await f.source.read(session)
    events.forEach((event) => expect(DomainEventSchema.safeParse(event).success).toBe(true))
    const saved = items(events)
    expect(saved.find((item) => item.role === 'user')).toMatchObject({
      text: prompt,
      attachments: ['data:image/png;base64,AA=='],
      createdAt: AT,
    })
    expect(saved.find((item) => item.type === 'reasoning')?.text).toBe('  Think\n')
    expect(saved.find((item) => item.command === 'node --version')).toMatchObject({
      id: 'a1:1',
      text: '  v22\n',
      status: 'failed',
      exitCode: 1,
      durationMs: 12,
    })
    expect(saved.find((item) => item.role === 'assistant')?.text).toBe(answer)
    expect(events.filter((event) => event.type === 'turn.completed')).toMatchObject([
      { status: 'completed', completedAt: AT + 2000 },
      { status: 'interrupted', completedAt: AT + 3000 },
    ])
    expect(await f.source.read(session)).toEqual(events)
  })

  it('recovers sibling tool results and assistant blocks without including an abandoned branch or subagent', async () => {
    const f = await fixture([
      row('u1', 'user', 'Run both'),
      row('a1', 'assistant', [], 'u1', {
        message: {
          id: 'shared',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'first' } }],
        },
      }),
      row('a2', 'assistant', [], 'a1', {
        message: {
          id: 'shared',
          content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'second' } }],
        },
      }),
      row(
        'r1',
        'user',
        [{ type: 'tool_result', tool_use_id: 't1', content: 'first result' }],
        'a1',
      ),
      row(
        'r2',
        'user',
        [{ type: 'tool_result', tool_use_id: 't2', content: 'second result' }],
        'a2',
      ),
      row('old', 'assistant', [{ type: 'text', text: 'Abandoned answer' }], 'r2'),
      row('active', 'assistant', [{ type: 'text', text: 'Current answer' }], 'r2'),
      row('side', 'assistant', [{ type: 'text', text: 'Subagent answer' }], 'active', {
        isSidechain: true,
      }),
    ])
    await writeFile(
      path.join(f.project, `${SECOND}.jsonl`),
      JSON.stringify(
        row('only-side', 'assistant', [{ type: 'text', text: 'Only subagent' }], null, {
          isSidechain: true,
        }),
      ),
    )
    await mkdir(path.join(f.project, SESSION, 'subagents'), { recursive: true })
    await writeFile(
      path.join(f.project, SESSION, 'subagents', 'agent-worker.jsonl'),
      JSON.stringify(row('nested', 'user', 'Nested')),
    )
    const sessions = await f.source.list()
    expect(sessions).toHaveLength(1)
    const text = items(await f.source.read(sessions[0]!))
      .map((item) => item.text)
      .join('\n')
    expect(text).toContain('first result')
    expect(text).toContain('second result')
    expect(text).toContain('Current answer')
    expect(text).not.toContain('Abandoned answer')
    expect(text).not.toContain('Subagent answer')
  })

  it('keeps the visible conversation before compaction and hides the synthetic summary', async () => {
    const f = await fixture([
      row('u1', 'user', 'Original prompt'),
      row('a1', 'assistant', [{ type: 'text', text: 'Original answer' }], 'u1'),
      {
        type: 'system',
        uuid: 'compact',
        parentUuid: null,
        logicalParentUuid: 'a1',
        subtype: 'compact_boundary',
        compactMetadata: { preservedMessages: {} },
      },
      row('summary', 'user', 'Synthetic compact summary', 'compact', { isCompactSummary: true }),
      row('u2', 'user', 'New prompt', 'summary'),
      row('a2', 'assistant', [{ type: 'text', text: 'New answer' }], 'u2'),
    ])
    const saved = items(await f.source.read((await f.source.list())[0]!))
    expect(saved.filter((item) => item.type === 'message').map((item) => item.text)).toEqual([
      'Original prompt',
      'Original answer',
      'New prompt',
      'New answer',
    ])
  })

  it('ends an interrupted turn at its Stop marker instead of showing the marker as a prompt', async () => {
    // Captured Claude 2.1.296 records: a Stop saves a user row with no prompt fields.
    const answered = row('a3', 'assistant', [{ type: 'text', text: 'Noted.' }], 'u3')
    answered.message = { ...answered.message, stop_reason: 'end_turn' } as typeof answered.message
    const f = await fixture([
      row('u1', 'user', [{ type: 'text', text: 'Write a story' }]),
      row('a1', 'assistant', [{ type: 'text', text: 'Once upon' }], 'u1'),
      row('stop', 'user', [{ type: 'text', text: '[Request interrupted by user]' }], 'a1', {
        promptId: 'p1',
      }),
      row('u2', 'user', [{ type: 'text', text: 'Run the tests' }], 'stop'),
      row(
        'a2',
        'assistant',
        [
          { type: 'text', text: 'Running them.' },
          { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'pnpm test' } },
        ],
        'u2',
      ),
      row(
        'stop-tool',
        'user',
        [
          { type: 'tool_result', tool_use_id: 'tool', content: 'Rejected', is_error: true },
          { type: 'text', text: '[Request interrupted by user for tool use]' },
        ],
        'a2',
      ),
      row('u3', 'user', '[Request interrupted by user] is what the log said', 'stop-tool'),
      answered,
    ])
    const session = (await f.source.list())[0]!
    const events = await f.source.read(session)
    const saved = items(events)
    expect(saved.filter((item) => item.type === 'message').map((item) => item.text)).toEqual([
      'Write a story',
      'Once upon',
      'Run the tests',
      'Running them.',
      '[Request interrupted by user] is what the log said',
      'Noted.',
    ])
    expect(saved.find((item) => item.command === 'pnpm test')).toMatchObject({
      status: 'failed',
      turnId: `${SESSION}:u2`,
    })
    expect(
      events.flatMap((event) => (event.type === 'turn.completed' ? [event.status] : [])),
    ).toEqual(['interrupted', 'interrupted', 'completed'])
  })

  it('hides SDK task notifications while preserving identical text pasted by the user', async () => {
    // Captured Claude 2.1.273 records use origin.kind, without isMeta or isSidechain.
    const notification =
      '<task-notification>\n<task-id>background</task-id>\n<status>stopped</status>\n</task-notification>'
    const f = await fixture([
      row('notification-before', 'user', notification, null, {
        origin: { kind: 'task-notification' },
        promptSource: 'sdk',
      }),
      row('u1', 'user', 'Start the preview', 'notification-before'),
      row('a1', 'assistant', [{ type: 'text', text: 'Checking the port.' }], 'u1'),
      row('notification', 'user', notification, 'a1', {
        origin: { kind: 'task-notification' },
        promptSource: 'sdk',
      }),
      row('u2', 'user', notification, 'notification'),
      row('a2', 'assistant', [{ type: 'text', text: 'That is a task notification.' }], 'u2'),
    ])
    const session = (await f.source.list())[0]!
    expect(session.title).toBe('Start the preview')
    const events = await f.source.read(session)
    expect(items(events).map((item) => item.text)).toEqual([
      'Start the preview',
      'Checking the port.',
      notification,
      'That is a task notification.',
    ])
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(2)
  })

  it('keeps tool identity stable when a result arrives, including image output and file changes', async () => {
    const f = await fixture([
      row('u1', 'user', 'Edit then inspect'),
      row(
        'a1',
        'assistant',
        [
          {
            type: 'tool_use',
            id: 'edit',
            name: 'Edit',
            input: { file_path: 'src/example.ts', old_string: 'before', new_string: 'after' },
          },
        ],
        'u1',
      ),
    ])
    const first = (await f.source.list())[0]!
    const before = await f.source.read(first)
    const call = before.find((event) => event.type === 'item.started')
    expect(call).toMatchObject({
      item: { id: 'a1:0', type: 'file_change', path: 'src/example.ts' },
    })
    await appendFile(
      f.file,
      JSON.stringify(
        row(
          'r1',
          'user',
          [
            {
              type: 'tool_result',
              tool_use_id: 'edit',
              content: [
                { type: 'text', text: 'Saved\n' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
                },
              ],
            },
          ],
          'a1',
        ),
      ) + '\n',
    )
    const result = items(await f.source.read((await f.source.list())[0]!)).find(
      (item) => item.id === 'a1:0',
    )
    expect(result).toMatchObject({
      type: 'file_change',
      path: 'src/example.ts',
      status: 'completed',
      attachments: ['data:image/png;base64,AA=='],
    })
    expect(result?.text).toContain('-before\n+after')
    expect(result?.text).toContain('Saved\n')
    expect(result?.text).not.toContain('base64')
  })

  it('isolates bad JSON, incomplete records, missing stores, and removed transcripts', async () => {
    const f = await fixture([row('u1', 'user', 'Valid')])
    await appendFile(f.file, 'not json\n{"type":"assistant"')
    await writeFile(path.join(f.project, `${SECOND}.jsonl`), '{bad')
    const session = (await f.source.list())[0]!
    expect(items(await f.source.read(session)).map((item) => item.text)).toEqual(['Valid'])
    expect(
      await createClaudeHistorySource({ configDir: path.join(f.configDir, 'absent') }).list(),
    ).toEqual([])
    await rm(f.file)
    expect(await f.source.read(session)).toEqual([])
    expect(await f.source.list()).toEqual([])
  })

  it('refuses transcript paths outside its configured history root', async () => {
    const f = await fixture([row('u1', 'user', 'Inside')])
    const session = (await f.source.list())[0]!
    const outside = path.join(f.configDir, `${SESSION}.jsonl`)
    await writeFile(outside, JSON.stringify(row('outside', 'user', 'Outside')))
    expect(await f.source.read({ ...session, locator: outside })).toEqual([])
    if (!canSymlink) return
    await rm(f.file)
    await symlink(outside, f.file)
    expect(await f.source.read(session)).toEqual([])
  })
})
