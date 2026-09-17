import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import type { DomainEvent, ProviderHistorySession, ProviderHistorySource } from '@harness/contracts'
import { ProviderHistory } from './provider-history.js'
import { Store } from './store.js'
import { compactHistoryReplay } from './history-replay.js'
import { orderProviderHistory } from './provider-history-order.js'

let store: Store
const histories: ProviderHistory[] = []
beforeEach(() => {
  store = new Store(':memory:')
  store.addProject(process.cwd())
})
afterEach(async () => {
  await Promise.all(histories.splice(0).map((history) => history.close()))
  store.close()
})

const metadata = (id = 'native'): ProviderHistorySession => ({
  id,
  workspacePath: process.cwd(),
  title: 'From the provider',
  createdAt: 1000,
  updatedAt: 2000,
  revision: '1',
})
const transcript = (
  id = 'native',
  text = '**Bold**\n\n```ts\nconst x = 1\n```',
  at = 1000,
): DomainEvent[] => [
  {
    type: 'thread.started',
    thread: { id, provider: 'codex', workspacePath: process.cwd(), createdAt: at },
  },
  {
    type: 'turn.started',
    turn: { id: `${id}-turn`, threadId: id, status: 'running', createdAt: at },
  },
  {
    type: 'item.completed',
    item: {
      id: `${id}-user`,
      turnId: `${id}-turn`,
      type: 'message',
      role: 'user',
      status: 'completed',
      text: 'Hello',
      createdAt: at,
    },
  },
  {
    type: 'item.completed',
    item: {
      id: `${id}-answer`,
      turnId: `${id}-turn`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      text,
      createdAt: at + 1,
    },
  },
  { type: 'turn.completed', turnId: `${id}-turn`, status: 'completed' },
]
function setup(sessions = [metadata()]) {
  const source: ProviderHistorySource = {
    list: vi.fn(async () => sessions),
    read: vi.fn(async (session) => transcript(session.id)),
    dispose: vi.fn(),
  }
  const hooks = { isBusy: vi.fn(() => false), changed: vi.fn(), log: vi.fn() }
  const history = new ProviderHistory(store, [{ provider: 'codex', history: source }], hooks)
  histories.push(history)
  return { history, source, hooks }
}
const messages = (id: string) =>
  compactHistoryReplay(store.history(id)).flatMap(({ event }) =>
    event.type === 'item.completed' && event.item.type === 'message' ? [event.item] : [],
  )

describe('provider history integration', () => {
  it.each(['codex', 'claude-code', 'grok'] as const)(
    'does not import a second %s task created while discovery is pending',
    async (provider) => {
      let release!: (sessions: ProviderHistorySession[]) => void
      const source: ProviderHistorySource = {
        list: () =>
          new Promise((resolve) => {
            release = resolve
          }),
        read: vi.fn(async () => transcript()),
      }
      const history = new ProviderHistory(store, [{ provider, history: source }], {
        isBusy: () => false,
        changed: vi.fn(),
        log: vi.fn(),
      })
      histories.push(history)
      const refresh = history.refresh()
      store.addThread({ id: 'native', provider, projectPath: process.cwd(), title: 'My design' })
      release([metadata()])
      await refresh
      expect(store.threads().map((thread) => thread.id)).toEqual(['native'])
      expect(store.providerHistories()[0]?.threadId).toBe('native')
    },
  )

  it('defers discovery while a provider start has not returned its task identity', async () => {
    let starting = true
    const source = { list: vi.fn(async () => [metadata()]), read: vi.fn(async () => transcript()) }
    const history = new ProviderHistory(store, [{ provider: 'codex', history: source }], {
      canImport: () => !starting,
      isBusy: () => false,
      changed: vi.fn(),
      log: vi.fn(),
    })
    histories.push(history)
    await history.refresh()
    expect(store.threads()).toEqual([])
    store.addThread({
      id: 'native',
      provider: 'codex',
      projectPath: process.cwd(),
      title: 'My design',
    })
    starting = false
    await history.refresh()
    expect(store.threads().map((thread) => thread.id)).toEqual(['native'])
  })

  it('does not discover temporary tasks as public chats', async () => {
    store.addThread({
      id: 'native',
      provider: 'codex',
      projectPath: process.cwd(),
      title: 'Side chat',
      ephemeral: true,
    })
    const { history } = setup()
    await history.refresh()
    expect(store.threads()).toEqual([])
    expect(store.providerHistories()).toEqual([])
  })

  it.each([false, true])(
    'repairs an existing duplicate without losing real replies (local reply: %s)',
    async (reply) => {
      const internal = transcript('native', 'Internal phase output')
      const user = internal[2]!
      if (user.type === 'item.completed')
        user.item.text = '<selected-reference-workflow>internal</selected-reference-workflow>'
      const outside = transcript('outside', 'Real outside answer', 90000).slice(1)
      const { history, source, hooks } = setup()
      vi.mocked(source.read).mockResolvedValue([...internal, ...outside])
      await history.refresh()
      const duplicateId = 'external:codex:native'
      await history.load(duplicateId)
      if (reply)
        for (const event of transcript('reply', 'Keep this reply', 180000).slice(1))
          store.append(duplicateId, event)
      store.addThread({
        id: 'native',
        provider: 'codex',
        projectPath: process.cwd(),
        title: 'My design',
      })
      for (const event of transcript('native', 'Clean design progress'))
        store.append('native', event)
      hooks.isBusy.mockImplementation((id) => id === 'native')
      await history.refresh()
      expect(store.thread(duplicateId)).toBeDefined()
      hooks.isBusy.mockReturnValue(false)
      await history.refresh()
      await history.load('native')
      expect(store.thread('native')?.title).toBe('My design')
      expect(messages('native').map((item) => item.text)).toEqual([
        'Hello',
        'Clean design progress',
        'Hello',
        'Real outside answer',
      ])
      expect(store.providerHistories()[0]).toMatchObject({
        threadId: 'native',
        loadedRevision: '1',
      })
      if (reply) {
        expect(messages(duplicateId).map((item) => item.text)).toContain('Keep this reply')
        expect(
          messages(duplicateId).some((item) => item.text?.includes('selected-reference-workflow')),
        ).toBe(false)
      } else expect(store.thread(duplicateId)).toBeUndefined()
      const restarted = new ProviderHistory(store, [{ provider: 'codex', history: source }], hooks)
      histories.push(restarted)
      await restarted.refresh()
      expect(store.providerHistories()[0]?.threadId).toBe('native')
      expect(
        messages('native').some((item) => item.text?.includes('selected-reference-workflow')),
      ).toBe(false)
    },
  )

  it('keeps the imported copy when canonical transcript recovery fails, then retries', async () => {
    const { history, source } = setup()
    await history.refresh()
    await history.load('external:codex:native')
    store.addThread({
      id: 'native',
      provider: 'codex',
      projectPath: process.cwd(),
      title: 'My design',
    })
    vi.mocked(source.read).mockRejectedValueOnce(new Error('temporarily unavailable'))
    await history.refresh()
    expect(messages('external:codex:native')).toHaveLength(2)
    await history.refresh()
    expect(store.thread('external:codex:native')).toBeUndefined()
    expect(messages('native')).toHaveLength(2)
  })

  it.each(['running', 'queued'] as const)(
    'defers recovery when the duplicate becomes %s during the read',
    async (busy) => {
      const { history, source, hooks } = setup()
      await history.refresh()
      await history.load('external:codex:native')
      store.addThread({
        id: 'native',
        provider: 'codex',
        projectPath: process.cwd(),
        title: 'My design',
      })
      let release!: (events: DomainEvent[]) => void
      vi.mocked(source.read).mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      const refresh = history.refresh()
      await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(2))
      if (busy === 'running')
        hooks.isBusy.mockImplementation((id) => id === 'external:codex:native')
      else
        store.enqueueQueuedTurn({
          id: 'queued',
          threadId: 'external:codex:native',
          text: 'Keep this queued prompt',
          attachments: [],
          options: {},
          createdAt: 10000,
        })
      release(transcript())
      await refresh
      expect(store.thread('external:codex:native')).toBeDefined()
      expect(store.providerHistories()[0]?.loadedRevision).toBeNull()
      if (busy === 'queued')
        expect(store.queuedTurns('external:codex:native')[0]?.text).toBe('Keep this queued prompt')
    },
  )

  it('retries failed reconciliation when the duplicate contains a real reply', async () => {
    const { history, source } = setup()
    await history.refresh()
    await history.load('external:codex:native')
    for (const event of transcript('reply', 'Keep this reply', 90000).slice(1))
      store.append('external:codex:native', event)
    store.addThread({
      id: 'native',
      provider: 'codex',
      projectPath: process.cwd(),
      title: 'My design',
    })
    vi.mocked(source.read).mockRejectedValueOnce(new Error('temporary failure'))
    await history.refresh()
    expect(store.providerHistories()[0]?.loadedRevision).toBeNull()
    await history.refresh()
    expect(store.providerHistories()[0]?.loadedRevision).toBe('1')
    expect(messages('external:codex:native').map((item) => item.text)).toContain('Keep this reply')
  })

  it('discards a pending read of a duplicate after ownership is reconciled', async () => {
    const { history, source } = setup()
    await history.refresh()
    let release!: (events: DomainEvent[]) => void
    vi.mocked(source.read).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const staleRead = history.load('external:codex:native')
    store.addThread({
      id: 'native',
      provider: 'codex',
      projectPath: process.cwd(),
      title: 'My design',
    })
    for (const event of transcript()) store.append('native', event)
    await history.refresh()
    release(transcript('native', 'Do not resurrect this duplicate'))
    expect(await staleRead).toBe(false)
    expect(store.thread('external:codex:native')).toBeUndefined()
    expect(messages('native')).toHaveLength(2)
  })

  it.each(['codex', 'claude-code', 'grok'] as const)(
    'imports %s chats only after their project is added in TasteCode',
    async (provider) => {
      store.removeProject(process.cwd())
      const source: ProviderHistorySource = {
        list: vi.fn(async () => [
          metadata(),
          { ...metadata('other'), workspacePath: path.join(process.cwd(), 'other') },
        ]),
        read: vi.fn(async (session) => transcript(session.id)),
      }
      const changed = vi.fn()
      const history = new ProviderHistory(store, [{ provider, history: source }], {
        isBusy: () => false,
        changed,
        log: vi.fn(),
      })
      histories.push(history)
      await history.refresh()
      expect(store.projects()).toEqual([])
      expect(store.threads()).toEqual([])
      expect(store.providerHistories()).toEqual([])
      expect(changed).not.toHaveBeenCalled()
      store.addProject(process.cwd(), 'My project')
      await history.refresh()
      expect(store.projects().map((project) => project.name)).toEqual(['My project'])
      expect(store.threads().map((thread) => thread.id)).toEqual([`external:${provider}:native`])
      expect(source.read).not.toHaveBeenCalled()
      await history.load(`external:${provider}:native`)
      expect(messages(`external:${provider}:native`)).toHaveLength(2)
    },
  )

  it('checks the project list again when a pending provider scan returns', async () => {
    const { history, source } = setup()
    let release!: (sessions: ProviderHistorySession[]) => void
    vi.mocked(source.list).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const refresh = history.refresh()
    store.removeProject(process.cwd())
    release([metadata()])
    await refresh
    expect(store.projects()).toEqual([])
    expect(store.threads()).toEqual([])
  })

  it('uses adapter identity mapping for old local session IDs', async () => {
    store.addProject(process.cwd())
    store.addThread({
      id: 'legacy-native',
      provider: 'codex',
      projectPath: process.cwd(),
      title: 'Existing',
    })
    const { history, source } = setup()
    source.resolveSessionId = (id) => id.replace(/^legacy-/, '')
    await history.refresh()
    expect(store.threads().map((thread) => thread.id)).toEqual(['legacy-native'])
    await history.load('legacy-native')
    expect(messages('legacy-native')).toHaveLength(2)
  })

  it('keeps a removed project hidden when new provider chats arrive', async () => {
    const sessions = [metadata()]
    const { history } = setup(sessions)
    await history.refresh()
    store.removeProject(process.cwd())
    sessions.push(metadata('new-chat'))
    await history.refresh()
    expect(store.projects()).toEqual([])
    expect(store.threads()).toHaveLength(1)
    store.addProject(process.cwd())
    await history.refresh()
    expect(store.threads()).toHaveLength(2)
  })

  it('retains distinct usage samples, replaces revised samples and suppresses local echoes', async () => {
    const usage = (inputTokens: number): DomainEvent => ({
      type: 'usage.updated',
      usage: {
        inputTokens,
        outputTokens: 0,
        totalTokens: inputTokens,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    })
    const withUsage = (counts: number[]) => [
      ...transcript().slice(0, -1),
      ...counts.map(usage),
      transcript().at(-1)!,
    ]
    const { history, source } = setup()
    vi.mocked(source.read).mockResolvedValue(withUsage([100, 100, 200]))
    await history.refresh()
    const id = store.threads()[0]!.id
    await history.load(id)
    expect(store.usageSummary(id, 0).session.totalTokens).toBe(400)
    vi.mocked(source.list).mockResolvedValue([{ ...metadata(), revision: '2' }])
    vi.mocked(source.read).mockResolvedValue(withUsage([100, 100, 250]))
    await history.refresh()
    await history.load(id)
    expect(store.usageSummary(id, 0).session.totalTokens).toBe(450)
    for (const event of [
      ...transcript('local-next', 'Local', 100000).slice(1, -1),
      usage(25),
      transcript('local-next').at(-1)!,
    ])
      store.append(id, event)
    vi.mocked(source.list).mockResolvedValue([{ ...metadata(), revision: '3' }])
    vi.mocked(source.read).mockResolvedValue([
      ...withUsage([100, 100, 250]),
      ...transcript('native-next', 'Local', 100005).slice(1, -1),
      usage(25),
      transcript('native-next').at(-1)!,
    ])
    await history.refresh()
    await history.load(id)
    expect(store.usageSummary(id, 0).session.totalTokens).toBe(475)
  })

  it('retries an empty read without deleting the previous saved transcript', async () => {
    const { history, source } = setup()
    await history.refresh()
    const id = store.threads()[0]!.id
    await history.load(id)
    vi.mocked(source.list).mockResolvedValue([{ ...metadata(), revision: '2' }])
    vi.mocked(source.read).mockResolvedValueOnce([])
    await history.refresh()
    await expect(history.load(id)).rejects.toThrow('unavailable')
    expect(messages(id)).toHaveLength(2)
    await history.load(id)
    expect(store.providerHistories()[0]!.loadedRevision).toBe('2')
  })
  it('counts old native cumulative usage before newer locally recorded usage', async () => {
    const usage = (totalTokens: number): DomainEvent => ({
      type: 'usage.updated',
      usage: {
        totalTokens,
        inputTokens: totalTokens,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        cumulative: true,
      },
    })
    store.addProject(process.cwd())
    store.addThread({
      id: 'local',
      provider: 'codex',
      providerSessionId: 'native',
      projectPath: process.cwd(),
      title: 'Existing',
    })
    for (const event of [...transcript('local-turn', 'Local', 90000), usage(200)])
      store.append('local', event)
    const { history, source } = setup()
    vi.mocked(source.read).mockResolvedValue([
      ...transcript().slice(0, -1),
      usage(100),
      transcript().at(-1)!,
    ])
    await history.refresh()
    await history.load('local')
    expect(store.usageSummary('local', 0).session.totalTokens).toBe(200)
    vi.mocked(source.list).mockResolvedValue([{ ...metadata(), revision: '2' }])
    vi.mocked(source.read).mockResolvedValue([
      ...transcript().slice(0, -1),
      usage(150),
      transcript().at(-1)!,
    ])
    await history.refresh()
    await history.load('local')
    expect(store.usageSummary('local', 0).session.totalTokens).toBe(200)
  })
  it('imports archived chats in the same metadata batch with their native activity time', async () => {
    const { history } = setup([
      metadata(),
      { ...metadata('archived'), archived: true, updatedAt: 8000 },
    ])
    await history.refresh()
    expect(store.threads()).toHaveLength(2)
    expect(store.thread('external:codex:archived')).toMatchObject({
      closedAt: 8000,
      lastActiveAt: 8000,
    })
  })
  it('matches repeated prompts once and keeps a distinct outside turn', async () => {
    store.addProject(process.cwd())
    store.addThread({
      id: 'local',
      provider: 'codex',
      providerSessionId: 'native',
      projectPath: process.cwd(),
      title: 'Existing',
    })
    for (const event of transcript('local-turn', 'Local', 1000)) store.append('local', event)
    const { history, source } = setup()
    vi.mocked(source.read).mockResolvedValue([
      ...transcript('native', 'Local', 1001),
      ...transcript('outside', 'Distinct', 10000).slice(1),
    ])
    await history.refresh()
    await history.load('local')
    expect(messages('local').map((item) => item.text)).toEqual([
      'Hello',
      'Local',
      'Hello',
      'Distinct',
    ])
  })

  it('deduplicates Design follow-up envelopes without hiding a genuine outside turn', async () => {
    const prompt = "dude it's NOT running start it at 4024"
    const wrapped =
      'This is an ordinary user turn, not an active TasteCode Design phase. Earlier phase-only JSON protocols no longer apply. Follow the current request normally and explain your work in normal prose, unless the user explicitly requests structured data. If asked to launch a preview, perform the launch on an available local port and report its URL instead of returning a preview-plan JSON object.\n\nUser request:\n' +
      prompt
    const withPrompt = (id: string, text: string, at: number) =>
      transcript(id, `${id} answer`, at).map((event): DomainEvent =>
        event.type === 'item.completed' && event.item.role === 'user'
          ? { ...event, item: { ...event.item, text } }
          : event,
      )
    store.addThread({
      id: 'local',
      provider: 'codex',
      providerSessionId: 'native',
      projectPath: process.cwd(),
      title: 'Existing',
    })
    for (const event of withPrompt('local-turn', prompt, 1000)) store.append('local', event)
    const { history, source } = setup()
    vi.mocked(source.read).mockResolvedValue([
      ...withPrompt('native', wrapped, 4451),
      ...withPrompt('outside', `Explain this\n\nUser request:\n${prompt}`, 9000).slice(1),
    ])
    await history.refresh()
    await history.load('local')
    expect(messages('local').map((item) => item.text)).toEqual([
      prompt,
      'local-turn answer',
      `Explain this\n\nUser request:\n${prompt}`,
      'outside answer',
    ])
  })

  it('orders old discovered turns before local replies without changing durable sequences', async () => {
    store.addProject(process.cwd())
    store.addThread({
      id: 'local',
      provider: 'codex',
      providerSessionId: 'native',
      projectPath: process.cwd(),
      title: 'Existing',
    })
    for (const event of transcript('local-turn', 'Newer', 90000)) store.append('local', event)
    const localPositions = store.localHistory('local').map(({ seq }) => seq)
    const { history } = setup()
    await history.refresh()
    await history.load('local')
    const replay = orderProviderHistory(compactHistoryReplay(store.history('local')))
    expect(
      replay.flatMap(({ event }) => (event.type === 'item.completed' ? [event.item.text] : [])),
    ).toEqual(['Hello', '**Bold**\n\n```ts\nconst x = 1\n```', 'Hello', 'Newer'])
    expect(store.localHistory('local').map(({ seq }) => seq)).toEqual(localPositions)
    expect(replay.at(-1)!.seq).toBe(store.lastSeq('local'))
  })

  it('hides a replaced native branch from history and triggers a partial replay reset', async () => {
    const { history, source } = setup()
    await history.refresh()
    const id = store.threads()[0]!.id
    await history.load(id)
    const before = store.lastSeq(id)
    vi.mocked(source.list).mockResolvedValue([{ ...metadata(), revision: '2' }])
    vi.mocked(source.read).mockResolvedValue(transcript('replacement', 'New branch', 2000))
    await history.refresh()
    await history.load(id)
    expect(messages(id).map((item) => item.text)).toEqual(['Hello', 'New branch'])
    expect(store.providerHistoryChangedAfter(id, before)).toBe(true)
  })

  it('reads the latest revision when a scan changes metadata during a pending read', async () => {
    const { history, source } = setup()
    await history.refresh()
    const id = store.threads()[0]!.id
    let resolve!: (events: DomainEvent[]) => void
    vi.mocked(source.read)
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done
        }),
      )
      .mockResolvedValue(transcript('native', 'Latest'))
    const loading = history.load(id)
    vi.mocked(source.list).mockResolvedValue([{ ...metadata(), revision: '2' }])
    await history.refresh()
    const second = history.load(id)
    resolve(transcript())
    await Promise.all([loading, second])
    expect(source.read).toHaveBeenCalledTimes(2)
    expect(messages(id)[1]!.text).toBe('Latest')
    expect(store.providerHistories()[0]!.loadedRevision).toBe('2')
  })
  it('discovers chats, groups projects and loads rich text only on demand', async () => {
    const { history, source } = setup()
    await history.refresh()
    const [thread] = store.threads()
    expect(thread).toMatchObject({
      id: 'external:codex:native',
      providerSessionId: 'native',
      title: 'From the provider',
    })
    expect(store.projects()).toHaveLength(1)
    expect(source.read).not.toHaveBeenCalled()
    expect(await history.load(thread!.id)).toBe(true)
    expect(messages(thread!.id).map((item) => item.text)).toEqual([
      'Hello',
      '**Bold**\n\n```ts\nconst x = 1\n```',
    ])
    expect(store.localHistory(thread!.id)).toEqual([])
    expect(await history.load(thread!.id)).toBe(false)
    expect(source.read).toHaveBeenCalledTimes(1)
  })

  it('refreshes existing items at new sequence positions without duplicates', async () => {
    const sessions = [metadata()]
    const { history, source } = setup(sessions)
    await history.refresh()
    const id = store.threads()[0]!.id
    await history.load(id)
    const after = store.lastSeq(id)
    sessions[0] = { ...sessions[0]!, revision: '2' }
    vi.mocked(source.read).mockResolvedValue(transcript('native', 'Updated\n\n- item'))
    await history.refresh()
    await history.load(id)
    expect(messages(id)).toHaveLength(2)
    expect(messages(id)[1]!.text).toBe('Updated\n\n- item')
    expect(store.history(id, after)).toHaveLength(1)
    expect(store.localHistory(id)).toEqual([])
  })

  it('keeps local titles, pins, closed state and deletion across scans and restarts', async () => {
    const sessions = [metadata()]
    const { history, source, hooks } = setup(sessions)
    await history.refresh()
    const id = store.threads()[0]!.id
    store.renameThread(id, 'My title')
    store.setThreadPinned(id, true)
    store.closeThread(id)
    sessions[0] = { ...sessions[0]!, title: 'Provider changed title', revision: '2' }
    const restarted = new ProviderHistory(store, [{ provider: 'codex', history: source }], hooks)
    histories.push(restarted)
    await restarted.refresh()
    expect(store.thread(id)).toMatchObject({
      title: 'My title',
      pinned: true,
      closedAt: expect.any(Number),
    })
    store.deleteThread(id)
    await restarted.refresh()
    expect(store.threads()).toEqual([])
  })

  it('deduplicates TasteCode sessions by native identity and imports only outside turns', async () => {
    store.addProject(process.cwd())
    store.addThread({
      id: 'local',
      provider: 'codex',
      providerSessionId: 'native',
      projectPath: process.cwd(),
      title: 'Existing',
    })
    for (const event of transcript('native')) store.append('local', event)
    const { history, source } = setup()
    vi.mocked(source.read).mockResolvedValue([
      ...transcript('native'),
      ...transcript('later', 'From outside', 90000).slice(1),
    ])
    await history.refresh()
    await history.load('local')
    expect(store.threads()).toHaveLength(1)
    expect(messages('local').map((item) => item.text)).toEqual([
      'Hello',
      '**Bold**\n\n```ts\nconst x = 1\n```',
      'Hello',
      'From outside',
    ])
  })

  it('matches local turns whose provider IDs differ using user content and native time', async () => {
    const { history, source } = setup()
    await history.refresh()
    const id = store.threads()[0]!.id
    await history.load(id)
    for (const event of transcript('local-next', 'Local reply', 100000).slice(1))
      store.append(id, event)
    vi.mocked(source.list).mockResolvedValue([{ ...metadata(), revision: '2' }])
    vi.mocked(source.read).mockResolvedValue([
      ...transcript(),
      ...transcript('native-next', 'Local reply', 100005).slice(1),
    ])
    await history.refresh()
    await history.load(id)
    expect(messages(id)).toHaveLength(4)
  })

  it('isolates unavailable providers and never imports actionable approvals', async () => {
    const good = setup()
    vi.mocked(good.source.read).mockResolvedValue([
      ...transcript(),
      {
        type: 'approval.requested',
        request: { id: 'old', kind: 'command', command: 'dangerous', createdAt: 1 },
      },
    ])
    const bad = {
      list: vi.fn().mockRejectedValue(new Error('private record contents')),
      read: vi.fn(),
    }
    const history = new ProviderHistory(
      store,
      [
        { provider: 'codex', history: good.source },
        { provider: 'grok', history: bad },
      ],
      good.hooks,
    )
    histories.push(history)
    await history.refresh()
    await history.load(store.threads()[0]!.id)
    expect(
      store
        .history(store.threads()[0]!.id)
        .some(({ event }) => event.type === 'approval.requested'),
    ).toBe(false)
    expect(good.hooks.log).toHaveBeenCalledWith('grok history could not be refreshed; will retry')
  })

  it('does not race a local turn or resurrect a chat deleted during a read', async () => {
    const { history, source, hooks } = setup()
    await history.refresh()
    const id = store.threads()[0]!.id
    hooks.isBusy.mockReturnValue(true)
    expect(await history.load(id)).toBe(false)
    expect(source.read).not.toHaveBeenCalled()
    hooks.isBusy.mockReturnValue(false)
    let resolve!: (events: DomainEvent[]) => void
    vi.mocked(source.read).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const read = history.load(id)
    store.deleteThread(id)
    resolve(transcript())
    expect(await read).toBe(false)
    expect(store.history(id)).toEqual([])
  })

  it('retries a failed read instead of recording an empty successful revision', async () => {
    const { history, source } = setup()
    await history.refresh()
    const id = store.threads()[0]!.id
    vi.mocked(source.read).mockRejectedValueOnce(new Error('temporarily unreadable'))
    await expect(history.load(id)).rejects.toThrow('temporarily unreadable')
    expect(await history.load(id)).toBe(true)
  })
})
