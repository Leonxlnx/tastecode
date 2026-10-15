import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, type ServerOptions, type WebSocketServer } from 'ws'
import { InvalidHistoryCursorError } from './history-page.js'
import { startServer } from './server.js'

const state = vi.hoisted(() => ({
  servers: [] as WebSocketServer[],
  projects: [] as Array<{ path: string }>,
  threads: new Map<string, { projectPath: string; worktreePath?: string }>(),
  historyPage: vi.fn(),
  read: [] as string[],
  reservedPreviewPorts: [] as Array<ReadonlySet<number> | undefined>,
  shutdown: [] as string[],
  historyClosed: Promise.resolve(),
  historySources: [] as string[][],
  historyLoads: [] as string[],
  invalidated: [] as string[],
  failGrokHistory: false,
  failHistoryService: false,
  historyRewritten: false,
  historyReads: [] as number[],
  historyRefresh: Promise.resolve() as Promise<void>,
  historyChanged: new Set<string>(),
}))
const temporary: string[] = []

// Exercise the real listener without opening user data or starting providers.
vi.mock('./data-location.js', () => ({ storeLocation: () => ':memory:' }))
vi.mock('./data-lease.js', () => ({ acquireDataLease: () => () => undefined }))
vi.mock('@harness/proc/desktop-path', () => ({ applyDesktopPath: () => undefined }))
vi.mock('./store.js', () => ({
  Store: class {
    projects() {
      return state.projects
    }
    thread(id: string) {
      return state.threads.get(id)
    }
    recoverInterruptedThreads() {}
    nextLifecycleRefreshAt() {}
    threadApproval() {
      return undefined
    }
    providerHistoryChangedAfter() {
      return false
    }
    historyRewrittenAfter() {
      return state.historyRewritten
    }
    close() {}
  },
}))
vi.mock('./orchestrator.js', () => ({
  resolveWorkspacePath: (workspace: string) => workspace,
  Orchestrator: class {
    constructor(_store: unknown, handlers: { reservedPreviewPorts?: ReadonlySet<number> }) {
      state.reservedPreviewPorts.push(handlers.reservedPreviewPorts)
    }
    async protectStoredCheckpoints() {}
    refreshLifecycle() {}
    async recoverWorktrees() {}
    async closeAllTerminals() {
      state.shutdown.push('terminals')
    }
    async disposeAll() {}
    historyPage(threadId: string, page: unknown) {
      return state.historyPage(threadId, page) as unknown
    }
    async historyForResponse(_threadId: string, afterSeq: number) {
      state.historyReads.push(afterSeq)
      return { events: [] }
    }
    async restoreCheckpoint() {
      return { undo: 'undo-token' }
    }
    async undoRestore() {}
    isTurnRunning() {
      return true
    }
    markThreadRead(threadId: string) {
      state.read.push(threadId)
    }
    invalidateImportedHistory(threadId: string) {
      state.invalidated.push(threadId)
    }
    async submitTurn() {
      return { queued: false, turnId: 'turn' }
    }
  },
}))
vi.mock('./providers.js', () => ({ prewarmProviders: () => undefined }))
vi.mock('./provider-history.js', () => ({
  ProviderHistory: class {
    constructor(_store: unknown, sources: Array<{ provider: string }>) {
      if (state.failHistoryService) throw new Error('history service failed')
      state.historySources.push(sources.map(({ provider }) => provider))
    }
    refresh() {
      return state.historyRefresh
    }
    async load(threadId: string) {
      state.historyLoads.push(threadId)
      return state.historyChanged.has(threadId)
    }
    async close() {
      state.shutdown.push('history')
      await state.historyClosed
    }
  },
}))
vi.mock('@harness/adapter-codex', () => ({ createCodexHistorySource: () => ({}) }))
vi.mock('@harness/adapter-claude-code', () => ({ createClaudeHistorySource: () => ({}) }))
vi.mock('@harness/adapter-grok', () => ({
  createGrokHistorySource: () => {
    if (state.failGrokHistory) throw new Error('grok history failed')
    return {}
  },
}))
vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>()
  return {
    ...actual,
    WebSocketServer: class extends actual.WebSocketServer {
      constructor(options: ServerOptions) {
        super(options)
        state.servers.push(this)
      }
    },
  }
})

let running: ReturnType<typeof startServer> | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
  state.servers.length = 0
  state.projects.length = 0
  state.threads.clear()
  state.historyPage.mockReset()
  state.read.length = 0
  state.reservedPreviewPorts.length = 0
  state.shutdown.length = 0
  state.historyClosed = Promise.resolve()
  state.historySources.length = 0
  state.historyLoads.length = 0
  state.invalidated.length = 0
  state.failGrokHistory = false
  state.failHistoryService = false
  state.historyRewritten = false
  state.historyReads.length = 0
  state.historyRefresh = Promise.resolve()
  state.historyChanged.clear()
  vi.unstubAllEnvs()
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function listen(accessToken?: string) {
  running = startServer({ port: 0, accessToken })
  const listener = state.servers.at(-1)!
  await once(listener, 'listening')
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener address')
  return { listener, port: address.port }
}

describe('rejected websocket connections', () => {
  it.each(['http://127.0.0.1:3000', 'https://evil.example'])(
    'refuses browser control from %s before sending a welcome',
    async (origin) => {
      const { port } = await listen()
      const client = new WebSocket(`ws://127.0.0.1:${port}`, { origin })
      const messages: unknown[] = []
      client.on('message', (message) => messages.push(message))
      try {
        const [code, reason] = await once(client, 'close')
        expect(code).toBe(1008)
        expect(String(reason)).toBe('Origin not allowed')
        expect(messages).toEqual([])
      } finally {
        client.terminate()
      }
    },
  )

  it.each([
    { origin: 'http://127.0.0.1:5183', accessToken: undefined },
    { origin: 'https://remote.example', accessToken: 'test-only' },
    { origin: 'http://127.0.0.1:3000', accessToken: 'test-only' },
  ])(
    'admits the renderer or an authenticated surface: $origin',
    async ({ origin, accessToken }) => {
      const { port } = await listen(accessToken)
      const client = new WebSocket(
        `ws://127.0.0.1:${port}/${accessToken ? `?token=${accessToken}` : ''}`,
        { origin },
      )
      try {
        const [message] = await once(client, 'message')
        expect(JSON.parse(String(message))).toMatchObject({ channel: 'server.welcome' })
      } finally {
        client.terminate()
      }
    },
  )

  it('uses the explicitly configured renderer origin instead of the dev port', async () => {
    vi.stubEnv('HARNESS_RENDERER_ORIGIN', 'http://127.0.0.1:6100')
    const { port } = await listen()
    const allowed = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'http://127.0.0.1:6100',
    })
    try {
      const [message] = await once(allowed, 'message')
      expect(JSON.parse(String(message))).toMatchObject({ channel: 'server.welcome' })
    } finally {
      allowed.terminate()
    }
    const rejected = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'http://127.0.0.1:5183',
    })
    try {
      const [code] = await once(rejected, 'close')
      expect(code).toBe(1008)
    } finally {
      rejected.terminate()
    }
  })

  it('keeps an unconfigured HTTP surface out of a file-only desktop server', async () => {
    vi.stubEnv('HARNESS_RENDERER_ORIGIN', 'file://')
    const { port } = await listen()
    for (const origin of [undefined, 'file://', 'http://127.0.0.1:5183']) {
      const client = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {})
      try {
        if (origin === 'http://127.0.0.1:5183') {
          const [code] = await once(client, 'close')
          expect(code).toBe(1008)
        } else {
          const [message] = await once(client, 'message')
          expect(JSON.parse(String(message))).toMatchObject({ channel: 'server.welcome' })
        }
      } finally {
        client.terminate()
      }
    }
  })

  it('keeps Design previews off the control port and the trusted renderer port', async () => {
    vi.stubEnv('HARNESS_RENDERER_ORIGIN', 'http://127.0.0.1:6100')
    await listen()
    await running?.close()
    vi.stubEnv('HARNESS_RENDERER_ORIGIN', 'file://')
    await listen()

    // `listen` asks for port 0, so that is the control port reserved here.
    expect(state.reservedPreviewPorts).toEqual([new Set([0, 6100]), new Set([0])])
  })

  it('rejects a malformed authentication URL without throwing from the listener', async () => {
    const { port } = await listen('test-only')
    const client = new WebSocket(`ws://127.0.0.1:${port}`, {
      finishRequest(request) {
        request.path = '//['
        request.end()
      },
    })
    try {
      const closed = once(client, 'close')
      await once(client, 'open')
      const [code, reason] = await closed
      expect(code).toBe(1008)
      expect(String(reason)).toBe('Access denied')
    } finally {
      client.terminate()
    }
  })

  it.each([
    { reason: 'access token', accessToken: 'test-only', origin: undefined },
    { reason: 'origin', accessToken: undefined, origin: 'https://evil.example' },
  ])('handles malformed frames after rejecting the $reason', async ({ accessToken, origin }) => {
    const { listener, port } = await listen(accessToken)
    let protectedListeners = 0
    const errors: Error[] = []
    const closed = new Promise<void>((resolve) => {
      listener.once('connection', (socket) => {
        protectedListeners = socket.listenerCount('error')
        // Keep a pre-fix regression failure local to this test process.
        socket.on('error', (error) => errors.push(error))
        socket.once('close', () => resolve())
      })
    })
    const client = connect({ host: '127.0.0.1', port })
    client.on('error', () => undefined)
    try {
      await once(client, 'connect')
      client.write(
        Buffer.concat([
          Buffer.from(
            `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
              'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
              'Sec-WebSocket-Version: 13\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
              (origin ? `Origin: ${origin}\r\n` : '') +
              '\r\n',
          ),
          // Client frames must be masked, even during a rejected close handshake.
          Buffer.from([0x81, 0x01, 0x78]),
        ]),
      )
      await closed
      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toContain('MASK must be set')
      expect(protectedListeners).toBeGreaterThan(0)
    } finally {
      client.destroy()
    }

    const healthy = new WebSocket(
      `ws://127.0.0.1:${port}/${accessToken ? `?token=${accessToken}` : ''}`,
    )
    try {
      const welcome = once(healthy, 'message')
      await once(healthy, 'open')
      const [message] = await welcome
      expect(JSON.parse(String(message))).toMatchObject({ channel: 'server.welcome' })
    } finally {
      healthy.terminate()
    }
  })
})

describe('workspace search requests', () => {
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harness-workspace-search-rpc-'))
    temporary.push(root)
    const projectPath = path.join(root, 'project')
    const worktreePath = path.join(root, 'isolated')
    await mkdir(path.join(projectPath, 'nested'), { recursive: true })
    await mkdir(path.join(worktreePath, 'nested'), { recursive: true })
    await writeFile(path.join(projectPath, 'nested', 'project-match.txt'), 'project')
    await writeFile(path.join(worktreePath, 'nested', 'isolated-match.txt'), 'isolated')
    state.projects.push({ path: projectPath })
    state.threads.set('isolated-thread', { projectPath, worktreePath })
    return { projectPath, worktreePath }
  }

  async function search(port: number, params: unknown) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    try {
      await once(client, 'message')
      const reply = once(client, 'message')
      client.send(JSON.stringify({ id: 'search', method: 'workspace.searchFiles', params }))
      const [message] = await reply
      return JSON.parse(String(message)) as unknown
    } finally {
      client.terminate()
    }
  }

  it('searches unopened folders in a registered project', async () => {
    const { projectPath } = await fixture()
    const { port } = await listen()
    expect(await search(port, { projectPath, query: ' MATCH ' })).toMatchObject({
      id: 'search',
      result: {
        entries: [{ name: 'project-match.txt', path: 'nested/project-match.txt' }],
        truncated: false,
      },
    })
  })

  it('uses the session checkout instead of the project root', async () => {
    const { projectPath } = await fixture()
    const { port } = await listen()
    expect(
      await search(port, { projectPath, threadId: 'isolated-thread', query: 'match' }),
    ).toMatchObject({
      result: {
        entries: [{ name: 'isolated-match.txt', path: 'nested/isolated-match.txt' }],
        truncated: false,
      },
    })
  })

  it('applies the listing registration and session ownership gates', async () => {
    const { projectPath, worktreePath } = await fixture()
    const { port } = await listen()
    expect(await search(port, { projectPath: worktreePath, query: 'match' })).toMatchObject({
      error: { message: 'project is not registered' },
    })
    expect(await search(port, { projectPath, threadId: 'missing', query: 'match' })).toMatchObject({
      error: { message: 'thread is not in this project' },
    })
    state.threads.set('foreign-thread', { projectPath: worktreePath })
    expect(
      await search(port, { projectPath, threadId: 'foreign-thread', query: 'match' }),
    ).toMatchObject({
      error: { message: 'thread is not in this project' },
    })
  })

  it.each([
    { query: '  ' },
    { query: 'x'.repeat(257) },
    { query: 'match', limit: 0 },
    { query: 'match', limit: 501 },
  ])('validates the search contract before walking: %j', async (params) => {
    const { projectPath } = await fixture()
    const { port } = await listen()
    expect(await search(port, { projectPath, ...params })).toMatchObject({
      error: { message: 'invalid params for workspace.searchFiles' },
    })
  })
})

describe('server shutdown', () => {
  it('starts closing terminals before it waits on provider history', async () => {
    let finishHistory: () => void = () => {}
    state.historyClosed = new Promise<void>((resolve) => {
      finishHistory = resolve
    })
    await listen()
    const closed = running!.close()
    running = undefined
    await new Promise((resolve) => setImmediate(resolve))
    expect(state.shutdown).toEqual(['terminals', 'history'])

    finishHistory()
    await closed
  })
})

describe('paged history requests', () => {
  async function history(port: number, params: unknown) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    try {
      await once(client, 'message')
      const reply = once(client, 'message')
      client.send(JSON.stringify({ id: 'history', method: 'thread.history', params }))
      const [message] = await reply
      return JSON.parse(String(message)) as unknown
    } finally {
      client.terminate()
    }
  }
  const turn = {
    seq: 7,
    event: {
      type: 'turn.started',
      turn: { id: 'turn', threadId: 't', status: 'running', createdAt: 1 },
    },
  }

  it('returns the newest page with its cursor and marks only that page read', async () => {
    state.historyPage.mockResolvedValue({
      events: [turn],
      page: { olderCursor: 'older', snapshotSeq: 7 },
    })
    const { port } = await listen()
    expect(await history(port, { threadId: 't', page: { turnLimit: 10 } })).toEqual({
      id: 'history',
      result: {
        events: [turn],
        running: true,
        approval: 'ask',
        page: { olderCursor: 'older', snapshotSeq: 7 },
      },
    })
    expect(state.historyPage).toHaveBeenCalledWith('t', { turnLimit: 10 })
    expect(state.read).toEqual(['t'])
  })

  it('passes a reset through and leaves read state alone for older pages', async () => {
    state.historyPage.mockResolvedValue({
      events: [turn],
      page: { olderCursor: null, snapshotSeq: 7 },
      reset: true,
    })
    const { port } = await listen()
    expect(
      await history(port, { threadId: 't', page: { before: 'cursor', turnLimit: 20 } }),
    ).toMatchObject({
      result: { reset: true, page: { olderCursor: null, snapshotSeq: 7 } },
    })
    expect(state.read).toEqual([])
  })

  it('answers a cursor it never issued as a bad request', async () => {
    state.historyPage.mockRejectedValue(new InvalidHistoryCursorError())
    const { port } = await listen()
    expect(await history(port, { threadId: 't', page: { before: 'forged' } })).toEqual({
      id: 'history',
      error: { code: 'bad_request', message: 'invalid history cursor' },
    })
  })
})

describe('unavailable provider history', () => {
  async function request(port: number, method: string, params: unknown) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    try {
      await once(client, 'message')
      const reply = once(client, 'message')
      client.send(JSON.stringify({ id: 'request', method, params }))
      const [message] = await reply
      return JSON.parse(String(message)) as unknown
    } finally {
      client.terminate()
    }
  }
  const opened = { result: { events: [], page: { olderCursor: null, snapshotSeq: 0 } } }
  const sent = { id: 'request', result: { queued: false, turnId: 'turn' } }

  it('keeps every other chat working when one provider source cannot load', async () => {
    state.failGrokHistory = true
    state.historyPage.mockResolvedValue(opened.result)
    const { port } = await listen()

    expect(await request(port, 'thread.history', { threadId: 'local', page: {} })).toMatchObject(
      opened,
    )
    expect(await request(port, 'thread.sendTurn', { threadId: 'local', text: 'hi' })).toEqual(sent)
    expect(
      await request(port, 'thread.history', { threadId: 'external:codex:s', page: {} }),
    ).toMatchObject(opened)
    expect(
      await request(port, 'thread.history', { threadId: 'external:grok:s', page: {} }),
    ).toMatchObject({ error: { message: 'grok history failed' } })
    expect(
      await request(port, 'thread.sendTurn', { threadId: 'external:grok:s', text: 'hi' }),
    ).toMatchObject({ error: { message: 'grok history failed' } })
    expect(state.historySources).toEqual([['codex', 'claude-code']])
    expect(state.historyLoads).toEqual(['local', 'local', 'external:codex:s'])
  })

  it('opens a local chat before the startup history scan finishes', async () => {
    let finishScan!: () => void
    state.historyRefresh = new Promise((resolve) => (finishScan = resolve))
    state.historyChanged.add('local')
    state.historyPage.mockResolvedValue(opened.result)
    const { port } = await listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages: Array<{ id?: string; channel?: string; data?: unknown }> = []
    client.on('message', (message) => messages.push(JSON.parse(String(message))))
    await once(client, 'message')
    const reply = (id: string) => messages.find((message) => message.id === id)
    const ask = (id: string, threadId: string) =>
      client.send(JSON.stringify({ id, method: 'thread.history', params: { threadId, page: {} } }))
    try {
      ask('local', 'local')
      await vi.waitFor(() => expect(reply('local')).toMatchObject(opened))
      ask('imported', 'external:codex:s')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(reply('imported')).toBeUndefined()
      expect(state.historyLoads).toEqual([])

      finishScan()
      await vi.waitFor(() => expect(reply('imported')).toMatchObject(opened))
      // The scan's outside changes still reach the local chat once it is done.
      await vi.waitFor(() =>
        expect(messages).toContainEqual(
          expect.objectContaining({
            channel: 'providerHistory.changed',
            data: { threadIds: ['local'] },
          }),
        ),
      )
      expect(state.invalidated).toContain('local')
      expect(state.historyLoads).toEqual(expect.arrayContaining(['local', 'external:codex:s']))
    } finally {
      client.terminate()
    }
  })
  it('fails only imported chats when the history service cannot start', async () => {
    state.failHistoryService = true
    state.historyPage.mockResolvedValue(opened.result)
    const { port } = await listen()

    expect(await request(port, 'thread.history', { threadId: 'local', page: {} })).toMatchObject(
      opened,
    )
    expect(await request(port, 'thread.sendTurn', { threadId: 'local', text: 'hi' })).toEqual(sent)
    expect(
      await request(port, 'thread.history', { threadId: 'external:codex:s', page: {} }),
    ).toMatchObject({ error: { message: 'history service failed' } })
  })
})

describe('chat history during the first provider scan', () => {
  async function connect(port: number) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages: Array<{ id?: string; channel?: string; data?: unknown; result?: unknown }> = []
    client.on('message', (message) => messages.push(JSON.parse(String(message))))
    await once(client, 'message')
    return { client, messages }
  }
  const opened = { events: [], page: { olderCursor: null, snapshotSeq: 0 } }

  it('answers a native chat before the scan ends and imports it right after', async () => {
    let finishScan!: () => void
    state.historyRefresh = new Promise<void>((resolve) => {
      finishScan = resolve
    })
    state.historyChanged.add('local')
    state.historyPage.mockResolvedValue(opened)
    const { port } = await listen()
    const viewer = await connect(port)
    try {
      viewer.client.send(
        JSON.stringify({
          id: 'local',
          method: 'thread.history',
          params: { threadId: 'local', page: {} },
        }),
      )
      viewer.client.send(
        JSON.stringify({
          id: 'imported',
          method: 'thread.history',
          params: { threadId: 'external:codex:s', page: {} },
        }),
      )
      // The native chat opens from the store while the scan still runs.
      await vi.waitFor(() =>
        expect(viewer.messages).toContainEqual(
          expect.objectContaining({ id: 'local', result: expect.objectContaining({ events: [] }) }),
        ),
      )
      expect(state.historyLoads).toEqual([])
      // An imported chat is the import, so it still waits for the scan.
      expect(viewer.messages.some((message) => message.id === 'imported')).toBe(false)

      finishScan()
      await vi.waitFor(() =>
        expect(viewer.messages).toContainEqual(expect.objectContaining({ id: 'imported' })),
      )
      await vi.waitFor(() =>
        expect(viewer.messages).toContainEqual(
          expect.objectContaining({
            channel: 'providerHistory.changed',
            data: { threadIds: ['local'] },
          }),
        ),
      )
      expect(state.historyLoads).toEqual(expect.arrayContaining(['local', 'external:codex:s']))
    } finally {
      viewer.client.terminate()
    }
  })

  it('imports before reading once the scan is done, as before', async () => {
    state.historyPage.mockResolvedValue(opened)
    const { port } = await listen()
    const reader = await connect(port)
    try {
      // Let the already-resolved scan settle.
      await new Promise((resolve) => setTimeout(resolve, 0))
      reader.client.send(
        JSON.stringify({
          id: 'local',
          method: 'thread.history',
          params: { threadId: 'local', page: {} },
        }),
      )
      await vi.waitFor(() =>
        expect(reader.messages).toContainEqual(expect.objectContaining({ id: 'local' })),
      )
      expect(state.historyLoads).toEqual(['local'])
    } finally {
      reader.client.terminate()
    }
  })
})

describe('checkpoint restores across clients', () => {
  async function connect(port: number) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages: unknown[] = []
    client.on('message', (message) => messages.push(JSON.parse(String(message))))
    await once(client, 'message')
    return { client, messages }
  }

  it.each([
    { method: 'thread.restore', params: { threadId: 't', checkpointId: 7 } },
    { method: 'thread.undoRestore', params: { threadId: 't', undo: 'undo-token' } },
  ])('tells every client to reload the chat after $method', async ({ method, params }) => {
    const { port } = await listen()
    const restorer = await connect(port)
    const viewer = await connect(port)
    try {
      restorer.client.send(JSON.stringify({ id: 'restore', method, params }))
      await vi.waitFor(() =>
        expect(viewer.messages).toContainEqual(
          expect.objectContaining({
            channel: 'providerHistory.changed',
            data: { threadIds: ['t'] },
          }),
        ),
      )
    } finally {
      restorer.client.terminate()
      viewer.client.terminate()
    }
  })

  it('resets an incremental history read whose cursor saw removed events', async () => {
    state.historyRewritten = true
    const { port } = await listen()
    const reader = await connect(port)
    try {
      reader.client.send(
        JSON.stringify({
          id: 'history',
          method: 'thread.history',
          params: { threadId: 't', afterSeq: 120 },
        }),
      )
      await vi.waitFor(() => expect(reader.messages).toHaveLength(2))
      expect(reader.messages[1]).toMatchObject({ id: 'history', result: { reset: true } })
      expect(state.historyReads).toEqual([0])
    } finally {
      reader.client.terminate()
    }
  })
})
