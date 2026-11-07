import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ChatImportJob,
  DomainEvent,
  ProviderHistorySession,
  ProviderHistorySource,
} from '@harness/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatImportService, importedThreadId, openCodeChatReader } from './chat-import.js'
import { createT3CodeReader } from './chat-import-t3.js'
import { ProjectFolders, ProviderHistory, savedFolder } from './provider-history.js'
import { Store } from './store.js'

let root: string
let store: Store
let history: ProviderHistory
let services: ChatImportService[]

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'chat-import-'))
  store = new Store(':memory:')
  services = []
})
afterEach(async () => {
  for (const service of services) service.close()
  await history?.close()
  store.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function folder(name: string): string {
  const created = path.join(root, name)
  mkdirSync(created, { recursive: true })
  return created
}

/** The temporary folder is inside the home folder on Windows and outside it on macOS. */
function homeLabel(folderPath: string): string {
  const relative = path.relative(os.homedir(), folderPath)
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? folderPath
    : path.join('~', relative)
}

function session(id: string, workspacePath: string, title = id): ProviderHistorySession {
  return { id, workspacePath, title, createdAt: 1000, updatedAt: 2000, revision: '1' }
}

function transcript(id: string, text = 'Reply'): DomainEvent[] {
  return [
    {
      type: 'thread.started',
      thread: { id, provider: 'codex', workspacePath: root, createdAt: 1000 },
    },
    {
      type: 'turn.started',
      turn: { id: `${id}-turn`, threadId: id, status: 'running', createdAt: 1000 },
    },
    {
      type: 'item.completed',
      item: {
        id: `${id}-prompt`,
        turnId: `${id}-turn`,
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'Prompt',
        createdAt: 1000,
      },
    },
    {
      type: 'item.completed',
      item: {
        id: `${id}-reply`,
        turnId: `${id}-turn`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text,
        createdAt: 1001,
      },
    },
    { type: 'turn.completed', turnId: `${id}-turn`, status: 'completed' },
  ]
}

function codexSource(
  sessions: ProviderHistorySession[],
  overrides: Partial<ProviderHistorySource> = {},
): ProviderHistorySource {
  return {
    list: async () => sessions,
    read: async (saved) => transcript(saved.id),
    ...overrides,
  }
}

/** The parts of T3 Code 0.1.7's `statev2.sqlite` the reader touches. */
function t3Database(
  home: string,
  threads: Array<{
    id: string
    folder: string
    title?: string
    provider?: string
    native?: string
    archived?: boolean
    subagent?: boolean
    deleted?: boolean
    items?: Array<{ type: string; payload: Record<string, unknown> }>
  }>,
): string {
  const userData = path.join(home, 'userdata')
  mkdirSync(path.join(userData, 'attachments'), { recursive: true })
  const db = new DatabaseSync(path.join(userData, 'statev2.sqlite'))
  db.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      default_provider TEXT NOT NULL, active_provider_thread_id TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
    CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, resume_cursor_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, ordinal INTEGER NOT NULL,
      type TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL);
  `)
  threads.forEach((thread, index) => {
    db.prepare('INSERT OR IGNORE INTO projection_projects VALUES (?, ?)').run(
      thread.folder,
      thread.folder,
    )
    db.prepare(
      `INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      thread.id,
      thread.folder,
      thread.title ?? thread.id,
      thread.provider ?? 'codex',
      thread.native ? `provider-${thread.id}` : null,
      '2026-10-01T10:00:00.000Z',
      `2026-10-0${index + 2}T10:00:00.000Z`,
      thread.archived ? '2026-10-20T10:00:00.000Z' : null,
      thread.deleted ? '2026-10-21T10:00:00.000Z' : null,
      JSON.stringify(thread.subagent ? { lineage: { relationshipToParent: 'subagent' } } : {}),
    )
    if (thread.native) {
      db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)').run(
        `provider-${thread.id}`,
        JSON.stringify({ nativeThreadRef: { nativeId: thread.native } }),
      )
    }
    const items = thread.items ?? [
      { type: 'user_message', payload: { text: 'Fix the header' } },
      { type: 'assistant_message', payload: { text: 'Fixed.' } },
    ]
    for (const [ordinal, item] of items.entries()) {
      const id = `${thread.id}-${ordinal}`
      if (item.type.endsWith('_message')) {
        db.prepare('INSERT INTO orchestration_v2_projection_messages VALUES (?, ?)').run(
          id,
          thread.id,
        )
      }
      db.prepare(
        `INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        thread.id,
        null,
        ordinal,
        item.type,
        'completed',
        '2026-10-02T10:00:00.000Z',
        JSON.stringify(item.payload),
      )
    }
  })
  db.close()
  return userData
}

async function service(options: {
  sessions?: ProviderHistorySession[]
  source?: ProviderHistorySource
  t3?: string
  opencode?: string
}) {
  const source = options.source ?? codexSource(options.sessions ?? [])
  history = new ProviderHistory(store, [{ provider: 'codex', history: source }], {
    isBusy: () => false,
    changed: () => {},
    log: () => {},
  })
  await history.refresh()
  const finished: Array<(job: ChatImportJob) => void> = []
  const created = new ChatImportService({
    store,
    history: async () => history,
    providerNames: new Map([['codex', 'Codex']]),
    readers: [
      createT3CodeReader({
        attachmentsDir: path.join(root, 'kept-pictures'),
        root: options.t3 ?? path.join(root, 'no-t3'),
      }),
      openCodeChatReader({ root: options.opencode ?? path.join(root, 'no-opencode') }),
    ],
    changed: () => {},
    progress: (job) => {
      if (job.state === 'finished') finished.splice(0).forEach((finish) => finish(job))
    },
    log: () => {},
  })
  services.push(created)
  const run = (ids: string[]) =>
    new Promise<ChatImportJob>((resolve) => {
      finished.push(resolve)
      created.start(ids)
    })
  return { service: created, run }
}

describe('chat import scan', () => {
  it('lists saved sessions wherever they ran, not only in projects', async () => {
    const site = folder('site')
    const { service: scanner } = await service({ sessions: [session('one', site, 'Hero spacing')] })
    const scan = await scanner.scan()
    expect(scan.sources).toEqual([
      { id: 'codex', name: 'Codex', provider: 'codex', state: 'ready' },
    ])
    expect(scan.chats).toEqual([
      expect.objectContaining({
        id: 'codex:one',
        title: 'Hero spacing',
        folder: site,
        continuation: 'session',
        imported: false,
      }),
    ])
    expect(scan.folders).toEqual([
      { path: site, name: 'site', label: homeLabel(site), isProject: false, missing: false },
    ])
  })

  it('leaves out helper sessions and sessions a chat left', async () => {
    const site = folder('site')
    store.addProject(site)
    store.addThread({ id: 'native', provider: 'codex', projectPath: site, title: 'Mine' })
    store.deleteThread('native', { keepSessionOut: true })
    const { service: scanner } = await service({
      sessions: [
        { ...session('helper', site), internal: true },
        session('native', site),
        session('visible', site),
      ],
    })
    const { chats } = await scanner.scan()
    expect(chats.map(({ id }) => id)).toEqual(['codex:visible'])
  })

  it('says a folder is gone instead of hiding its chats', async () => {
    const gone = path.join(root, 'deleted-folder')
    const { service: scanner } = await service({ sessions: [session('one', gone)] })
    const { folders } = await scanner.scan()
    expect(folders[0]).toMatchObject({ path: gone, missing: true })
  })

  it('reports a source still scanning, and one it could not read, without hiding the rest', async () => {
    const site = folder('site')
    let release!: (sessions: ProviderHistorySession[]) => void
    const pending = new Promise<ProviderHistorySession[]>((resolve) => (release = resolve))
    history = new ProviderHistory(
      store,
      [{ provider: 'codex', history: codexSource([], { list: () => pending }) }],
      { isBusy: () => false, changed: () => {}, log: () => {} },
    )
    const t3 = t3Database(path.join(root, 'broken-t3'), [{ id: 'a', folder: site }])
    writeFileSync(path.join(t3, 'statev2.sqlite'), 'not a database')
    const scanner = new ChatImportService({
      store,
      history: async () => history,
      providerNames: new Map([['codex', 'Codex']]),
      readers: [
        createT3CodeReader({
          attachmentsDir: path.join(root, 'pictures'),
          root: path.join(root, 'broken-t3'),
        }),
      ],
      changed: () => {},
      progress: () => {},
      log: () => {},
    })
    services.push(scanner)
    void history.refresh()
    const scan = await scanner.scan()
    expect(scan.sources).toEqual([
      { id: 'codex', name: 'Codex', provider: 'codex', state: 'scanning' },
      { id: 't3-code', name: 'T3 Code', state: 'failed' },
    ])
    release([])
  })
})

describe('chat import scan of a failing source', () => {
  it('stops saying scanning once a first listing has failed', async () => {
    const { service: scanner } = await service({
      source: codexSource([], { list: () => Promise.reject(new Error('corrupt index')) }),
    })
    const { sources } = await scanner.scan()
    expect(sources).toEqual([{ id: 'codex', name: 'Codex', provider: 'codex', state: 'failed' }])
  })
})

describe('T3 Code chats', () => {
  it('skips deleted chats, sub-agents and chats without a message', async () => {
    const site = folder('site')
    const t3 = path.join(root, 't3')
    t3Database(t3, [
      { id: 'kept', folder: site },
      { id: 'deleted', folder: site, deleted: true },
      { id: 'subagent', folder: site, subagent: true },
      { id: 'blank', folder: site, items: [] },
    ])
    const { service: scanner } = await service({ t3 })
    const { chats } = await scanner.scan()
    expect(chats.map(({ id }) => id)).toEqual(['t3-code:kept'])
  })

  it('folds a chat T3 Code ran on a saved session into one row that continues it', async () => {
    const site = folder('site')
    const t3 = path.join(root, 't3')
    t3Database(t3, [{ id: 'thread', folder: site, title: 'Named in T3', native: 'native-1' }])
    const { service: scanner, run } = await service({
      sessions: [session('native-1', site, 'First prompt')],
      t3,
    })
    const { chats } = await scanner.scan()
    expect(chats).toEqual([
      expect.objectContaining({
        id: 't3-code:thread',
        alsoIn: ['codex'],
        continuation: 'session',
        title: 'Named in T3',
      }),
    ])

    await expect(run(['t3-code:thread'])).resolves.toMatchObject({ imported: 1, failed: 0 })

    expect(store.thread('external:codex:native-1')).toMatchObject({
      providerSessionId: 'native-1',
      title: 'Named in T3',
    })
    expect(store.threadNeedsHandover('external:codex:native-1')).toBe(false)
    await history.refresh()
    expect(store.thread('external:codex:native-1')?.title).toBe('Named in T3')
  })

  it('copies a chat whose session ran in another checkout, so it opens in the project', async () => {
    const site = folder('site')
    const checkout = folder('t3-worktree')
    const t3 = path.join(root, 't3')
    t3Database(t3, [{ id: 'thread', folder: site, native: 'native-1' }])
    const { service: scanner, run } = await service({
      sessions: [session('native-1', checkout)],
      t3,
    })
    const { chats } = await scanner.scan()
    expect(chats).toEqual([
      expect.objectContaining({ id: 't3-code:thread', alsoIn: ['codex'], continuation: 'copy' }),
    ])
    await run(['t3-code:thread'])
    expect(store.thread(importedThreadId('t3-code', 'thread'))?.projectPath).toBe(site)
    expect(store.thread('external:codex:native-1')).toBeUndefined()
  })

  it('copies the transcript, hands it to the next session and keeps the source untouched', async () => {
    const site = folder('site')
    const t3 = path.join(root, 't3')
    const userData = t3Database(t3, [
      {
        id: 'thread',
        folder: site,
        title: 'Copied chat',
        provider: 'claudeAgent',
        archived: true,
        items: [
          {
            type: 'user_message',
            payload: {
              text: 'Fix the header',
              startedAt: '2026-10-01T10:00:00.000Z',
              attachments: [{ type: 'image', id: 'shot', mimeType: 'image/png', name: 'shot.png' }],
            },
          },
          { type: 'reasoning', payload: { text: 'Checking the layout' } },
          { type: 'command_execution', payload: { input: 'pnpm test', output: 'passed' } },
          {
            type: 'file_change',
            payload: { fileName: 'src/header.tsx', diffStr: '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n' },
          },
          {
            type: 'dynamic_tool',
            payload: { toolName: 'read', input: { path: 'a.ts' }, output: 'x'.repeat(100_000) },
          },
          { type: 'checkpoint', payload: {} },
          { type: 'assistant_message', payload: { text: 'Fixed.' } },
        ],
      },
    ])
    writeFileSync(path.join(userData, 'attachments', 'shot.png'), 'picture')
    const before = readFileSync(path.join(userData, 'statev2.sqlite'))
    const stamp = statSync(path.join(userData, 'statev2.sqlite')).mtimeMs

    const { service: scanner, run } = await service({ t3 })
    await scanner.scan()
    await expect(run(['t3-code:thread'])).resolves.toMatchObject({
      imported: 1,
      projects: [site],
    })

    const id = importedThreadId('t3-code', 'thread')
    expect(store.thread(id)).toMatchObject({
      title: 'Copied chat',
      provider: 'claude-code',
      projectPath: site,
    })
    expect(store.thread(id)?.providerSessionId).toBeUndefined()
    expect(store.thread(id)?.closedAt).toBeDefined()
    expect(store.threadNeedsHandover(id)).toBe(true)

    const items = store
      .history(id)
      .flatMap(({ event }) => (event.type === 'item.completed' ? [event.item] : []))
    expect(items.map(({ type }) => type)).toEqual([
      'message',
      'reasoning',
      'command',
      'file_change',
      'tool_call',
      'message',
    ])
    expect(items[2]).toMatchObject({ command: 'pnpm test', text: 'passed' })
    expect(items[3]).toMatchObject({ path: 'src/header.tsx', linesAdded: 1, linesRemoved: 1 })
    expect(items[4]?.text?.length).toBeLessThan(70_000)
    const kept = path.join(root, 'kept-pictures', 't3-code', 'shot.png')
    expect(items[0]?.attachments).toEqual([kept])
    expect(readFileSync(kept, 'utf8')).toBe('picture')

    expect(readFileSync(path.join(userData, 'statev2.sqlite')).equals(before)).toBe(true)
    expect(statSync(path.join(userData, 'statev2.sqlite')).mtimeMs).toBe(stamp)
  })

  it('reads the older database of a T3 Code that never migrated', async () => {
    const site = folder('site')
    const userData = path.join(root, 't3', 'userdata')
    mkdirSync(userData, { recursive: true })
    const db = new DatabaseSync(path.join(userData, 'state.sqlite'))
    db.exec(`
      CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL);
      CREATE TABLE projection_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, archived_at TEXT);
      CREATE TABLE provider_session_runtime (
        thread_id TEXT PRIMARY KEY, provider_name TEXT NOT NULL, resume_cursor_json TEXT);
      CREATE TABLE projection_thread_messages (
        message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, attachments_json TEXT);
    `)
    db.prepare('INSERT INTO projection_projects VALUES (?, ?)').run('p', site)
    db.prepare('INSERT INTO projection_threads VALUES (?, ?, ?, ?, ?, NULL, NULL)').run(
      'old',
      'p',
      'From the older build',
      '2026-07-01T10:00:00.000Z',
      '2026-07-02T10:00:00.000Z',
    )
    db.prepare('INSERT INTO provider_session_runtime VALUES (?, ?, ?)').run(
      'old',
      'claudeAgent',
      JSON.stringify({ resume: 'session-1' }),
    )
    const message = db.prepare(
      'INSERT INTO projection_thread_messages VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    message.run('m1', 'old', 't1', 'user', 'Hello', '2026-07-01T10:00:00.000Z', null)
    message.run('m2', 'old', 't1', 'reasoning', 'Thinking', '2026-07-01T10:00:01.000Z', null)
    message.run('m3', 'old', 't1', 'assistant', 'Hi', '2026-07-01T10:00:02.000Z', null)
    db.close()

    const { service: scanner, run } = await service({ t3: path.join(root, 't3') })
    const { chats } = await scanner.scan()
    expect(chats).toEqual([
      expect.objectContaining({ provider: 'claude-code', title: 'From the older build' }),
    ])
    await run(['t3-code:old'])
    const types = store
      .history(importedThreadId('t3-code', 'old'))
      .flatMap(({ event }) => (event.type === 'item.completed' ? [event.item.type] : []))
    expect(types).toEqual(['message', 'reasoning', 'message'])
  })
})

describe('importing chosen chats', () => {
  it('brings in only the chosen session of a folder that becomes a project', async () => {
    const site = folder('site')
    const { service: scanner, run } = await service({
      sessions: [session('chosen', site), session('left-out', site)],
    })
    await scanner.scan()

    await expect(run(['codex:chosen'])).resolves.toMatchObject({
      state: 'finished',
      done: 1,
      total: 1,
      imported: 1,
      failed: 0,
      projects: [site],
    })
    expect(store.project(site)).toBeDefined()
    expect(store.thread('external:codex:chosen')?.title).toBe('chosen')

    // The next scan must not bring in what was left unchosen.
    await history.refresh()
    expect(store.thread('external:codex:left-out')).toBeUndefined()

    // It stays listed, and can still be imported later.
    const { chats } = await scanner.scan()
    expect(chats.find(({ id }) => id === 'codex:chosen')?.imported).toBe(true)
    expect(chats.find(({ id }) => id === 'codex:left-out')?.imported).toBe(false)
    await expect(run(['codex:left-out'])).resolves.toMatchObject({ imported: 1, projects: [] })
    expect(store.thread('external:codex:left-out')).toBeDefined()
  })

  it('names the most recently used chat it imported, for the way there', async () => {
    const site = folder('site')
    const { service: scanner, run } = await service({
      sessions: [
        { ...session('older', site), updatedAt: 2000 },
        { ...session('newest', site), updatedAt: 9000 },
        { ...session('middle', site), updatedAt: 5000 },
      ],
    })
    await scanner.scan()
    await expect(run(['codex:older', 'codex:newest', 'codex:middle'])).resolves.toMatchObject({
      thread: 'external:codex:newest',
    })
  })

  it('reads a transcript while importing, so a chat opens without its source', async () => {
    const site = folder('site')
    const { service: scanner, run } = await service({ sessions: [session('one', site)] })
    await scanner.scan()
    await run(['codex:one'])
    const texts = store
      .history('external:codex:one')
      .flatMap(({ event }) => (event.type === 'item.completed' ? [event.item.text] : []))
    expect(texts).toEqual(['Prompt', 'Reply'])
  })

  it('counts a transcript it cannot read as failed and leaves no empty chat', async () => {
    const site = folder('site')
    const { service: scanner, run } = await service({
      source: codexSource([session('good', site), session('bad', site)], {
        read: async (saved) => {
          if (saved.id === 'bad') throw new Error('corrupt')
          return transcript(saved.id)
        },
      }),
    })
    await scanner.scan()
    await expect(run(['codex:bad', 'codex:good'])).resolves.toMatchObject({
      done: 2,
      imported: 1,
      failed: 1,
    })
    expect(store.thread('external:codex:bad')).toBeUndefined()
    expect(store.thread('external:codex:good')).toBeDefined()
  })

  it('imports into an existing project without announcing a new one', async () => {
    const site = folder('site')
    store.addProject(site, 'My name for it')
    const t3 = path.join(root, 't3')
    t3Database(t3, [{ id: 'thread', folder: site }])
    const { service: scanner, run } = await service({ t3 })
    await scanner.scan()
    await expect(run(['t3-code:thread'])).resolves.toMatchObject({ imported: 1, projects: [] })
    expect(store.project(site)?.name).toBe('My name for it')
  })

  it('takes only ids from its own scan and one import at a time', async () => {
    const site = folder('site')
    const { service: scanner } = await service({
      sessions: [session('one', site), session('two', site)],
    })
    await scanner.scan()
    expect(() => scanner.start(['codex:/etc/passwd'])).toThrow('no longer listed')
    scanner.start(['codex:one'])
    expect(() => scanner.start(['codex:two'])).toThrow('already running')
  })

  it('says what a running import has done when a client asks again', async () => {
    const site = folder('site')
    const { service: scanner, run } = await service({ sessions: [session('one', site)] })
    await scanner.scan()
    await run(['codex:one'])
    await expect(scanner.scan()).resolves.toMatchObject({
      job: { state: 'finished', imported: 1 },
    })
  })

  it('imports nothing twice', async () => {
    const site = folder('site')
    const t3 = path.join(root, 't3')
    t3Database(t3, [{ id: 'thread', folder: site }])
    const { service: scanner, run } = await service({ t3 })
    await scanner.scan()
    await run(['t3-code:thread'])
    await scanner.scan()
    expect(() => scanner.start(['t3-code:thread'])).toThrow('no longer listed')
  })
})

describe('OpenCode chats', () => {
  it('resumes the saved session rather than carrying a copy', async () => {
    const site = folder('site')
    const opencode = folder('opencode')
    const db = new DatabaseSync(path.join(opencode, 'opencode.db'))
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    db.prepare('INSERT INTO session_v2 VALUES (?, NULL, ?, ?, 1000, 2000, NULL)').run(
      'ses_one',
      site,
      'Fix the footer',
    )
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, 1000, ?)').run(
      'm1',
      'ses_one',
      'user',
      1,
      JSON.stringify({ text: 'Fix the footer' }),
    )
    db.close()

    const { service: scanner, run } = await service({ opencode })
    const { chats, sources } = await scanner.scan()
    expect(sources).toContainEqual({
      id: 'opencode',
      name: 'OpenCode',
      provider: 'opencode',
      state: 'ready',
    })
    expect(chats).toEqual([
      expect.objectContaining({ id: 'opencode:ses_one', continuation: 'session' }),
    ])
    await run(['opencode:ses_one'])
    const id = importedThreadId('opencode', 'ses_one')
    expect(store.thread(id)).toMatchObject({ provider: 'opencode', providerSessionId: 'ses_one' })
    expect(store.threadNeedsHandover(id)).toBe(false)
  })

  it('files a folder saved with forward slashes under the spelling the other apps use', async () => {
    const site = folder('site')
    const opencode = folder('opencode')
    const db = new DatabaseSync(path.join(opencode, 'opencode.db'))
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    // What OpenCode writes on Windows; elsewhere this is the folder unchanged.
    db.prepare('INSERT INTO session_v2 VALUES (?, NULL, ?, ?, 1000, 2000, NULL)').run(
      'ses_one',
      site.replaceAll('\\', '/'),
      'Fix the footer',
    )
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, 1000, ?)').run(
      'm1',
      'ses_one',
      'user',
      1,
      JSON.stringify({ text: 'Fix the footer' }),
    )
    db.close()

    const { service: scanner, run } = await service({
      opencode,
      sessions: [session('one', site, 'Hero spacing')],
    })
    const scan = await scanner.scan()
    expect(scan.chats.map(({ folder: saved }) => saved)).toEqual([site, site])
    expect(scan.folders.map(({ path: saved }) => saved)).toEqual([site])
    const job = await run(['opencode:ses_one', 'codex:one'])
    expect(job.projects).toEqual([site])
    expect(store.projects().map(({ path: saved }) => saved)).toEqual([site])
  })
})

describe('saved folder spelling', () => {
  it.runIf(process.platform === 'win32')(
    'lists a Codex session saved under the long-path prefix in its folder',
    async () => {
      const site = folder('site')
      const sessions = [session('one', site), session('two', `\\\\?\\${site}`)]
      const { service: scanner, run } = await service({ sessions })
      const scan = await scanner.scan()
      expect(scan.folders.map(({ path: saved }) => saved)).toEqual([site])
      const job = await run(['codex:one', 'codex:two'])
      expect(job.projects).toEqual([site])
      // Later work in Codex reaches the chat: its scan finds the project under that spelling.
      sessions[1] = { ...sessions[1]!, title: 'Renamed in Codex', revision: '2' }
      await history.refresh()
      expect(store.thread('external:codex:two')?.title).toBe('Renamed in Codex')
    },
  )

  it.runIf(process.platform === 'win32')(
    'files one folder once across drive case and a trailing separator',
    async () => {
      const site = folder('site')
      const lower = `${site[0]!.toLowerCase()}${site.slice(1)}\\`
      const { service: scanner, run } = await service({
        sessions: [session('one', site), session('two', lower)],
      })
      const scan = await scanner.scan()
      expect(scan.folders.map(({ path: saved }) => saved)).toEqual([site])
      expect(new Set(scan.chats.map(({ folder: saved }) => saved))).toEqual(new Set([site]))
      const job = await run(['codex:one', 'codex:two'])
      expect(job.projects).toEqual([site])
    },
  )

  it.runIf(process.platform === 'win32')(
    'continues a T3 Code chat on its Codex session when only the drive case differs',
    async () => {
      const site = folder('site')
      const t3 = path.join(root, 't3')
      t3Database(t3, [{ id: 'thread', folder: site, native: 'native-1' }])
      const lower = `${site[0]!.toLowerCase()}${site.slice(1)}`
      const { service: scanner } = await service({ sessions: [session('native-1', lower)], t3 })
      const { chats } = await scanner.scan()
      expect(chats).toEqual([
        expect.objectContaining({ id: 't3-code:thread', continuation: 'session' }),
      ])
    },
  )

  it('gives each folder one spelling on Windows and leaves it alone elsewhere', () => {
    expect(savedFolder('\\\\?\\E:\\work\\site', 'win32')).toBe('E:\\work\\site')
    expect(savedFolder('\\\\?\\UNC\\server\\share\\site', 'win32')).toBe('\\\\server\\share\\site')
    expect(savedFolder('E:/work/site', 'win32')).toBe('E:\\work\\site')
    expect(savedFolder('E:\\work\\site', 'win32')).toBe('E:\\work\\site')
    expect(savedFolder('e:\\work\\site\\', 'win32')).toBe('E:\\work\\site')
    expect(savedFolder('e:\\', 'win32')).toBe('E:\\')
    expect(savedFolder('\\\\server\\share\\', 'win32')).toBe('\\\\server\\share\\')
    expect(savedFolder('/work/site', 'darwin')).toBe('/work/site')
    expect(savedFolder('/work/site/', 'darwin')).toBe('/work/site/')
  })
})
