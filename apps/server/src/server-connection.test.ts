import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, type ServerOptions, type WebSocketServer } from 'ws'
import { InvalidHistoryCursorError } from './history-page.js'
import { generateNoiseKeyPair, NoiseInitiator, type NoiseSession } from './phone-noise.js'
import { startServer } from './server.js'

const state = vi.hoisted(() => ({
  servers: [] as WebSocketServer[],
  projects: [] as Array<{ path: string }>,
  threads: new Map<
    string,
    { projectPath: string; worktreePath?: string; provider?: string; accountId?: string }
  >(),
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
  prewarmed: 0,
  recovered: 0,
  historyScans: new Map<string, Promise<void>>(),
  historyCopies: new Set<string>(),
  idleCheckouts: [] as string[],
  handled: [] as string[],
  accountCalls: [] as unknown[][],
  accountList: [] as unknown[],
  usageHistory: undefined as { accountHomes?: () => unknown } | undefined,
  usageHistoryCalls: [] as unknown[][],
  earlierChanges: new Map<string, unknown>(),
  accountsRoot: '',
  accountsChanged: (_provider: string) => {},
  credentials: new Map<string, string>(),
  renamed: [] as string[],
}))
const temporary: string[] = []

// Exercise the real listener without opening user data or starting providers.
vi.mock('./data-location.js', () => ({ storeLocation: () => ':memory:' }))
vi.mock('./data-lease.js', () => ({ acquireDataLease: () => () => undefined }))
// The phone link key belongs in the system keychain, never in a test run's.
vi.mock('./credentials.js', () => ({
  readCredential: (reference: string) => {
    const value = state.credentials.get(reference)
    if (value === undefined) throw new Error('missing')
    return value
  },
  writeCredential: (reference: string, value: string) => state.credentials.set(reference, value),
  hasCredential: (reference: string) => state.credentials.has(reference),
  removeCredential: (reference: string) => state.credentials.delete(reference),
}))
vi.mock('@harness/proc/desktop-path', () => ({ applyDesktopPath: () => undefined }))
vi.mock('./store.js', () => ({
  Store: class {
    projects() {
      state.handled.push('projects.list')
      return state.projects
    }
    thread(id: string) {
      return state.threads.get(id)
    }
    usageSummary() {
      const none = {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      }
      return { session: none, today: none }
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
    feedbackLedger() {
      return undefined
    }
    setFeedbackLedger() {}
    phoneAccessState() {
      return undefined
    }
    setPhoneAccessState() {}
    renameThread(threadId: string) {
      state.renamed.push(threadId)
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
    async recoverWorktrees() {
      state.recovered += 1
    }
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
    async whileCheckoutIdle(checkout: string, operation: () => Promise<unknown>) {
      state.idleCheckouts.push(checkout)
      return operation()
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
    account(provider: string, _agent?: string, accountId?: string) {
      state.handled.push(`auth.status(${provider}${accountId ? `, ${accountId}` : ''})`)
      return Promise.resolve({ signedIn: false })
    }
    async startLogin(provider: string, accountId?: string) {
      state.handled.push(`auth.startLogin(${provider}, ${accountId})`)
      return { loginId: 'login-1' }
    }
    async cancelLogin(provider: string, loginId: string, accountId?: string) {
      state.handled.push(`auth.cancelLogin(${provider}, ${loginId}, ${accountId})`)
    }
    async useApiKey(provider: string, _apiKey: string, accountId?: string) {
      state.handled.push(`auth.useApiKey(${provider}, ${accountId})`)
      return { signedIn: true }
    }
    async signOut(provider: string, _agent?: string, accountId?: string) {
      state.handled.push(`auth.signOut(${provider}, ${accountId})`)
    }
    async listModels(provider: string, _agent?: string, accountId?: string) {
      state.handled.push(`models.list(${provider}, ${accountId})`)
      return []
    }
    launchProviderLogin(
      target: string,
      command: string,
      _columns: number,
      _rows: number,
      account?: { id: string; environment: Record<string, string> },
    ) {
      state.handled.push(`providers.launch(${target}, ${command}, ${JSON.stringify(account)})`)
      return 'login-terminal'
    }
    async releaseAccount(provider: string, accountId: string, unregister: () => void) {
      state.accountCalls.push(['release', provider, accountId])
      unregister()
    }
    async startThread(
      provider: string,
      workspacePath: string,
      options: { accountId?: string; continueFrom?: string },
    ) {
      const id = `${provider}-started`
      state.threads.set(id, { projectPath: workspacePath, provider })
      const from = options.continueFrom === undefined ? '' : `, from ${options.continueFrom}`
      state.handled.push(`thread.start(${provider}, ${options.accountId ?? 'active'}${from})`)
      return { id }
    }
    earlierChanges(threadId: string) {
      return state.earlierChanges.get(threadId)
    }
    heldLimitSource() {
      return undefined
    }
    async usageLimitSource(provider: string, _intent?: string, accountId?: string) {
      state.handled.push(`usage.limits(${provider}, ${accountId})`)
      return { provider, ...(accountId ? { accountId } : {}), status: 'ready', limits: [] }
    }
    async consumeRateLimitReset(
      provider: string,
      _idempotencyKey: string,
      _creditId?: string,
      accountId?: string,
    ) {
      state.handled.push(`usage.consumeReset(${provider}, ${accountId})`)
      return { outcome: 'reset' }
    }
  },
}))
vi.mock('./providers.js', () => ({
  prewarmProviders: () => {
    state.prewarmed += 1
  },
  launchCommandFor: async (provider: string) => `${provider} login`,
}))
// The registry's own rules are covered in provider-accounts.test.ts; this is its wiring.
vi.mock('./provider-accounts.js', () => ({
  ProviderAccounts: class {
    constructor(_rows: unknown, options: { root: string; onChanged: (provider: string) => void }) {
      state.accountsRoot = options.root
      state.accountsChanged = options.onChanged
    }
    list(provider?: string) {
      state.accountCalls.push(['list', provider])
      return { accounts: state.accountList, active: {} }
    }
    create(provider: string, label: string, home: { kind: string; path?: string }) {
      state.accountCalls.push(['create', provider, label, home])
      const managed = home.kind === 'managed'
      return { id: 'work-1a2b3c', provider, label, home: home.path ?? path.resolve('w'), managed }
    }
    rename(provider: string, accountId: string, label: string) {
      state.accountCalls.push(['rename', provider, accountId, label])
      return { id: accountId, provider, label, managed: false }
    }
    removal(provider: string, accountId: string, deleteHome: boolean) {
      state.accountCalls.push(['removal', provider, accountId, deleteHome])
      return {
        unregister: () => state.accountCalls.push(['unregister', provider, accountId]),
        deleteFolder: async () => {
          state.accountCalls.push(['deleteFolder', provider, accountId])
        },
      }
    }
    setActive(provider: string, accountId: string) {
      state.accountCalls.push(['setActive', provider, accountId])
    }
    supports(provider: string) {
      return provider !== 'grok'
    }
    environment(_provider: string, accountId: string | undefined) {
      return accountId === undefined || accountId === 'default' ? {} : { ACCOUNT_HOME: accountId }
    }
    home(provider: string, accountId: string | undefined) {
      if (accountId === undefined || accountId === 'default') return undefined
      if (provider === 'grok') throw new Error('This provider runs as one account only.')
      return path.resolve(accountId)
    }
    recordIdentity(provider: string, accountId: string | undefined, account: unknown) {
      state.accountCalls.push(['recordIdentity', provider, accountId, account])
    }
  },
}))
// The index's own rules are covered in usage-history.test.ts; this is its wiring.
vi.mock('./usage-history.js', () => ({
  UsageHistoryService: class {
    constructor(options: { accountHomes?: () => unknown }) {
      state.usageHistory = options
    }
    async startBackgroundRefresh() {}
    async history(...args: unknown[]) {
      state.usageHistoryCalls.push(args)
      return { range: args[0] }
    }
    dispose() {}
  },
}))
vi.mock('./runtime-loader.js', () => ({
  stopModelListings: async () => {
    state.shutdown.push('listings')
  },
}))
vi.mock('./provider-history.js', () => ({
  ProviderHistory: class {
    constructor(_store: unknown, sources: Array<{ provider: string }>) {
      if (state.failHistoryService) throw new Error('history service failed')
      state.historySources.push(sources.map(({ provider }) => provider))
    }
    refresh() {
      return state.historyRefresh
    }
    scanned(provider: string) {
      return state.historyScans.get(provider) ?? state.historyRefresh
    }
    hasCopy(threadId: string) {
      return state.historyCopies.has(threadId)
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
// One declared method that no route handles, the state a contract is in when
// it lands before its server handler.
vi.mock('@harness/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@harness/contracts')>()
  return {
    ...actual,
    methods: { ...actual.methods, 'test.unrouted': actual.methods['system.info'] },
  }
})
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
  state.prewarmed = 0
  state.recovered = 0
  state.historyScans.clear()
  state.historyCopies.clear()
  state.idleCheckouts.length = 0
  state.handled.length = 0
  state.accountCalls.length = 0
  state.accountList = []
  state.usageHistory = undefined
  state.usageHistoryCalls.length = 0
  state.credentials.clear()
  state.renamed.length = 0
  vi.unstubAllEnvs()
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, maxRetries: 5 })),
  )
})

async function listen(accessToken?: string) {
  running = startServer({ port: 0, accessToken })
  const listener = state.servers.at(-1)!
  await once(listener, 'listening')
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener address')
  return { listener, port: address.port }
}

/** The renderer's first request; background startup work waits for its answer. */
async function askForProjects(port: number) {
  const client = new WebSocket(`ws://127.0.0.1:${port}`)
  try {
    await once(client, 'message')
    const reply = once(client, 'message')
    client.send(JSON.stringify({ id: 'projects', method: 'projects.list', params: {} }))
    await reply
  } finally {
    client.terminate()
  }
  await new Promise((resolve) => setImmediate(resolve))
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

describe('methods without a route', () => {
  async function ask(port: number, method: string) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    try {
      await once(client, 'message')
      const reply = once(client, 'message')
      client.send(JSON.stringify({ id: 'ask', method, params: {} }))
      const [message] = await reply
      return JSON.parse(String(message)) as unknown
    } finally {
      client.terminate()
    }
  }

  it('answers a declared but unrouted method as unknown instead of an empty result', async () => {
    const { port } = await listen()
    expect(await ask(port, 'test.unrouted')).toEqual({
      id: 'ask',
      error: { code: 'bad_request', message: 'unknown method: test.unrouted' },
    })
  })

  it('still answers an undeclared method the same way', async () => {
    const { port } = await listen()
    expect(await ask(port, 'no.such.method')).toEqual({
      id: 'ask',
      error: { code: 'bad_request', message: 'unknown method: no.such.method' },
    })
  })
})

describe('provider accounts', () => {
  async function connect(port: number) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages: Array<Record<string, unknown>> = []
    client.on('message', (message) => messages.push(JSON.parse(String(message))))
    await once(client, 'message')
    let next = 0
    const ask = async (method: string, params: unknown) => {
      const id = `ask-${(next += 1)}`
      client.send(JSON.stringify({ id, method, params }))
      await vi.waitFor(() => expect(messages.some((message) => message['id'] === id)).toBe(true))
      return messages.find((message) => message['id'] === id)
    }
    return { client, messages, ask }
  }

  it('answers the accounts methods and tells every client when they change', async () => {
    const { port } = await listen()
    const { client, messages, ask } = await connect(port)
    try {
      expect(path.basename(state.accountsRoot)).toBe('accounts')
      expect(await ask('accounts.list', { provider: 'codex' })).toMatchObject({
        result: { accounts: [], active: {} },
      })
      expect(
        await ask('accounts.create', {
          provider: 'codex',
          label: ' Work ',
          home: { kind: 'managed' },
        }),
      ).toMatchObject({ result: { account: { id: 'work-1a2b3c', label: 'Work', managed: true } } })
      await ask('accounts.rename', { provider: 'codex', accountId: 'default', label: 'Mine' })
      await ask('accounts.setActive', { provider: 'codex', accountId: 'work-1a2b3c' })
      expect(
        await ask('accounts.remove', { provider: 'codex', accountId: 'work-1a2b3c' }),
      ).toMatchObject({ result: {} })
      await ask('accounts.remove', {
        provider: 'codex',
        accountId: 'work-1a2b3c',
        deleteHome: true,
      })
      expect(
        await ask('accounts.create', {
          provider: 'codex',
          label: 'Relative',
          home: { kind: 'existing', path: 'relative/folder' },
        }),
      ).toMatchObject({ error: { code: 'bad_request' } })
      expect(state.accountCalls).toEqual([
        ['list', 'codex'],
        ['create', 'codex', 'Work', { kind: 'managed' }],
        ['rename', 'codex', 'default', 'Mine'],
        ['setActive', 'codex', 'work-1a2b3c'],
        // Refusals come first; the account stops resolving before what runs
        // as it stops, and its folder goes last.
        ['removal', 'codex', 'work-1a2b3c', false],
        ['release', 'codex', 'work-1a2b3c'],
        ['unregister', 'codex', 'work-1a2b3c'],
        ['deleteFolder', 'codex', 'work-1a2b3c'],
        ['removal', 'codex', 'work-1a2b3c', true],
        ['release', 'codex', 'work-1a2b3c'],
        ['unregister', 'codex', 'work-1a2b3c'],
        ['deleteFolder', 'codex', 'work-1a2b3c'],
      ])

      state.accountsChanged('claude-code')
      await vi.waitFor(() =>
        expect(messages).toContainEqual(
          expect.objectContaining({
            channel: 'accounts.changed',
            data: { provider: 'claude-code' },
          }),
        ),
      )
      // A new folder holds no sign-in, so nobody is asked who is signed in there.
      expect(state.handled).toEqual([])
    } finally {
      client.terminate()
    }
  })

  it('asks a folder the user brought who is signed in there once it is added', async () => {
    const { port } = await listen()
    const { client, ask } = await connect(port)
    try {
      const brought = path.resolve('brought')
      expect(
        await ask('accounts.create', {
          provider: 'codex',
          label: 'Old laptop',
          home: { kind: 'existing', path: brought },
        }),
      ).toMatchObject({ result: { account: { id: 'work-1a2b3c', managed: false } } })
      await vi.waitFor(() =>
        expect(state.accountCalls).toContainEqual([
          'recordIdentity',
          'codex',
          'work-1a2b3c',
          { signedIn: false },
        ]),
      )
      expect(state.handled).toEqual(['auth.status(codex, work-1a2b3c)'])
    } finally {
      client.terminate()
    }
  })

  it('refuses an account it cannot run instead of acting on the default one', async () => {
    const { port } = await listen()
    const { client, ask } = await connect(port)
    try {
      expect(
        await ask('usage.history', {
          range: '7d',
          account: { provider: 'grok', accountId: 'work' },
        }),
      ).toMatchObject({
        error: { code: 'internal', message: 'This provider runs as one account only.' },
      })
      expect(state.usageHistoryCalls).toEqual([])
      expect(state.handled).toEqual([])
      // A chat is pinned to its account by the orchestrator, which checks it.
      for (const accountId of ['work', undefined]) {
        expect(
          await ask('thread.start', { provider: 'codex', accountId, workspacePath: 'C:\\x' }),
        ).toMatchObject({ result: { threadId: 'codex-started' } })
      }
      // Carrying a chat on to another account reaches the orchestrator, which checks it.
      expect(
        await ask('thread.start', {
          provider: 'codex',
          accountId: 'work',
          continueFrom: 'codex-earlier',
          workspacePath: 'C:\\x',
        }),
      ).toMatchObject({ result: { threadId: 'codex-started' } })
      expect(state.handled.filter((entry) => entry.startsWith('thread.'))).toEqual([
        'thread.start(codex, work)',
        'thread.start(codex, active)',
        'thread.start(codex, work, from codex-earlier)',
      ])
      // Where the earlier chat's uncommitted changes went comes back with the new chat.
      const kept = { carried: false, keptIn: 'C:\\trees\\earlier' }
      state.earlierChanges.set('codex-started', kept)
      expect(
        await ask('thread.start', {
          provider: 'codex',
          accountId: 'work',
          continueFrom: 'codex-earlier',
          workspacePath: 'C:\\x',
        }),
      ).toMatchObject({ result: { threadId: 'codex-started', earlierChanges: kept } })
      state.earlierChanges.clear()
    } finally {
      client.terminate()
    }
  })

  it('runs sign-in, sign-out, the sign-in terminal and model lists as the account asked for', async () => {
    const { port } = await listen()
    const { client, ask } = await connect(port)
    try {
      for (const [method, params] of [
        ['auth.status', { provider: 'codex', accountId: 'work' }],
        ['auth.startLogin', { provider: 'claude-code', accountId: 'work' }],
        ['auth.cancelLogin', { provider: 'claude-code', accountId: 'work', loginId: 'login-1' }],
        ['auth.useApiKey', { provider: 'codex', accountId: 'work', apiKey: 'test-key' }],
        ['auth.signOut', { provider: 'codex', accountId: 'work' }],
        ['models.list', { provider: 'codex', accountId: 'work' }],
        ['providers.launch', { provider: 'codex', accountId: 'work', columns: 80, rows: 24 }],
        ['providers.launch', { provider: 'codex', columns: 80, rows: 24 }],
      ] as const) {
        expect(await ask(method, params), method).toHaveProperty('result')
      }
      expect(state.handled).toEqual([
        'auth.status(codex, work)',
        'auth.startLogin(claude-code, work)',
        'auth.cancelLogin(claude-code, login-1, work)',
        'auth.useApiKey(codex, work)',
        'auth.signOut(codex, work)',
        'models.list(codex, work)',
        'providers.launch(codex, codex login, {"id":"work","environment":{"ACCOUNT_HOME":"work"}})',
        'providers.launch(codex, codex login, undefined)',
      ])
      // The CLI's own answers name the account's identity.
      expect(state.accountCalls).toEqual([
        ['recordIdentity', 'codex', 'work', { signedIn: false }],
        ['recordIdentity', 'codex', 'work', { signedIn: true }],
      ])
    } finally {
      client.terminate()
    }
  })

  it('answers plan limits and spends reset credits as the account asked for', async () => {
    const { port } = await listen()
    const { client, ask } = await connect(port)
    state.threads.set('work-chat', { projectPath: 'C:\\x', provider: 'codex', accountId: 'work' })
    state.threads.set('own-chat', { projectPath: 'C:\\x', provider: 'codex' })
    try {
      expect(await ask('usage.summary', { provider: 'codex', accountId: 'work' })).toMatchObject({
        result: { limitSource: { provider: 'codex', accountId: 'work', status: 'ready' } },
      })
      await ask('usage.summary', { provider: 'codex' })
      // A chat's limits are its account's, whichever account is active.
      await ask('usage.summary', { threadId: 'work-chat' })
      await ask('usage.summary', { threadId: 'own-chat' })
      for (const accountId of ['work', undefined]) {
        expect(
          await ask('usage.consumeReset', {
            provider: 'codex',
            accountId,
            idempotencyKey: crypto.randomUUID(),
          }),
        ).toMatchObject({ result: { outcome: 'reset' } })
      }
      expect(state.handled).toEqual([
        'usage.limits(codex, work)',
        'usage.limits(codex, undefined)',
        'usage.limits(codex, work)',
        'usage.limits(codex, undefined)',
        'usage.consumeReset(codex, work)',
        'usage.consumeReset(codex, undefined)',
      ])
    } finally {
      client.terminate()
    }
  })

  it("reads every other account's folder into usage and answers one account alone", async () => {
    const { port } = await listen()
    const { client, ask } = await connect(port)
    try {
      await ask('usage.history', { range: '7d' })
      state.accountList = [
        { id: 'default', provider: 'codex', label: 'Default', managed: false },
        { id: 'work', provider: 'codex', label: 'Work', home: 'D:\\work', managed: true },
        { id: 'work', provider: 'claude-code', label: 'Work', home: 'D:\\claude', managed: false },
      ]
      expect(state.usageHistory?.accountHomes?.()).toEqual([
        { provider: 'codex', accountId: 'work', home: 'D:\\work' },
        { provider: 'claude-code', accountId: 'work', home: 'D:\\claude' },
      ])
      const account = { provider: 'codex', accountId: 'work' }
      await ask('usage.history', { range: '30d', refresh: true, account })
      expect(state.usageHistoryCalls).toEqual([
        ['7d', false, undefined],
        ['30d', true, account],
      ])
    } finally {
      client.terminate()
    }
  })

  it('remembers an identity only from the CLI sign-in check itself', async () => {
    const { port } = await listen()
    const { client, ask } = await connect(port)
    try {
      await ask('auth.status', { provider: 'codex', accountId: 'default' })
      await ask('auth.status', { provider: 'claude-code' })
      await ask('auth.status', { provider: 'codex', agent: 'my-harness' })
      expect(state.accountCalls).toEqual([
        ['recordIdentity', 'codex', 'default', { signedIn: false }],
        ['recordIdentity', 'claude-code', undefined, { signedIn: false }],
      ])
    } finally {
      client.terminate()
    }
  })
})

describe('the pull request for a chat checkout', () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, windowsHide: true, stdio: 'ignore' })
  }

  async function forCheckout(port: number, params: unknown) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    try {
      await once(client, 'message')
      const reply = once(client, 'message')
      client.send(JSON.stringify({ id: 'pr', method: 'pullRequests.forCheckout', params }))
      const [message] = await reply
      return JSON.parse(String(message)) as unknown
    } finally {
      client.terminate()
    }
  }

  it('reads the chat worktree, not the project folder, without asking GitHub', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harness-checkout-pr-rpc-'))
    temporary.push(root)
    // Never discover a repository above the temporary folder.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', root)
    const projectPath = path.join(root, 'project')
    const worktreePath = path.join(root, 'isolated')
    await mkdir(projectPath)
    await mkdir(worktreePath)
    git(worktreePath, 'init', '-q', '-b', 'chat/one')
    git(
      worktreePath,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'first',
    )
    state.projects.push({ path: projectPath })
    state.threads.set('isolated-thread', { projectPath, worktreePath })
    const { port } = await listen()

    expect(await forCheckout(port, { projectPath })).toMatchObject({
      result: { available: false, reason: 'not_git' },
    })
    expect(
      await forCheckout(port, { projectPath, threadId: 'isolated-thread', refresh: true }),
    ).toMatchObject({
      result: { available: false, reason: 'no_remote', branch: 'chat/one' },
    })
  })
  // Every step spawns git, which takes a while on a busy Windows machine.
}, 30_000)

describe('git writes in a chat checkout', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim()
  }

  async function call(port: number, method: string, params: unknown) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    try {
      await once(client, 'message')
      const reply = once(client, 'message')
      client.send(JSON.stringify({ id: 'git', method, params }))
      const [message] = await reply
      return JSON.parse(String(message)) as unknown
    } finally {
      client.terminate()
    }
  }

  it('commits in the chat worktree while no turn runs there, then pushes it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harness-workspace-git-rpc-'))
    temporary.push(root)
    // Never discover a repository above the temporary folder.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', root)
    const projectPath = path.join(root, 'project')
    const worktreePath = path.join(root, 'isolated')
    const remote = path.join(root, 'remote.git')
    await mkdir(projectPath)
    git(root, 'init', '-q', '--bare', remote)
    git(root, 'init', '-q', '-b', 'chat/one', worktreePath)
    git(worktreePath, 'config', 'user.email', 'test@example.com')
    git(worktreePath, 'config', 'user.name', 'Test')
    git(worktreePath, 'config', 'commit.gpgsign', 'false')
    git(worktreePath, 'remote', 'add', 'origin', remote)
    await writeFile(path.join(worktreePath, 'change.txt'), 'changed\n')
    state.projects.push({ path: projectPath })
    state.threads.set('isolated-thread', { projectPath, worktreePath })
    const { port } = await listen()
    const checkout = { projectPath, threadId: 'isolated-thread' }

    const committed = await call(port, 'workspace.commit', {
      ...checkout,
      message: 'feat: from review',
      includeUntracked: true,
    })
    expect(committed).toEqual({
      id: 'git',
      result: { commit: git(worktreePath, 'rev-parse', 'HEAD'), branch: 'chat/one' },
    })
    expect(state.idleCheckouts).toEqual([worktreePath])

    expect(await call(port, 'workspace.push', checkout)).toEqual({
      id: 'git',
      result: { branch: 'chat/one', remote: 'origin' },
    })
    expect(git(remote, 'rev-parse', 'refs/heads/chat/one')).toBe(
      git(worktreePath, 'rev-parse', 'HEAD'),
    )

    expect(
      await call(port, 'pullRequests.create', { ...checkout, title: 'x', body: '', draft: false }),
    ).toMatchObject({
      error: { code: 'internal', message: 'This checkout has no GitHub remote named origin.' },
    })
  })
  // Every step spawns git, which takes a while on a busy Windows machine.
}, 60_000)

describe('server shutdown', () => {
  it('starts closing terminals before it waits on provider history', async () => {
    let finishHistory: () => void = () => {}
    state.historyClosed = new Promise<void>((resolve) => {
      finishHistory = resolve
    })
    await askForProjects((await listen()).port)
    const closed = running!.close()
    running = undefined
    await new Promise((resolve) => setImmediate(resolve))
    expect(state.shutdown).toEqual(['terminals', 'history'])

    finishHistory()
    await closed
  })

  it('stops model listings that are still running', async () => {
    await listen()
    await running!.close()
    running = undefined
    expect(state.shutdown).toContain('listings')
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

  it("starts a turn after its own provider's scan, not every provider's", async () => {
    let finishClaude!: () => void
    state.historyScans.set('claude-code', new Promise<void>((resolve) => (finishClaude = resolve)))
    state.historyScans.set('codex', Promise.resolve())
    state.historyRefresh = new Promise<void>(() => undefined)
    state.threads.set('codex-chat', { projectPath: '/work', provider: 'codex' })
    state.threads.set('claude-chat', { projectPath: '/work', provider: 'claude-code' })
    const { port } = await listen()
    const viewer = await connect(port)
    const send = (id: string) =>
      viewer.client.send(
        JSON.stringify({ id, method: 'thread.sendTurn', params: { threadId: id, text: 'hi' } }),
      )
    try {
      send('codex-chat')
      send('claude-chat')
      await vi.waitFor(() =>
        expect(viewer.messages).toContainEqual(expect.objectContaining({ id: 'codex-chat' })),
      )
      expect(state.historyLoads).toEqual(['codex-chat'])
      expect(viewer.messages.some((message) => message.id === 'claude-chat')).toBe(false)

      finishClaude()
      await vi.waitFor(() =>
        expect(viewer.messages).toContainEqual(expect.objectContaining({ id: 'claude-chat' })),
      )
      expect(state.historyLoads).toEqual(['codex-chat', 'claude-chat'])
    } finally {
      viewer.client.terminate()
    }
  })

  it('sends the first turn of a chat started in this run without waiting for the scan', async () => {
    let finishClaude!: () => void
    state.historyScans.set('claude-code', new Promise<void>((resolve) => (finishClaude = resolve)))
    state.historyRefresh = new Promise<void>(() => undefined)
    // A chat from before the launch may have turns taken in the CLI meanwhile.
    state.threads.set('claude-earlier', { projectPath: '/work', provider: 'claude-code' })
    const { port } = await listen()
    const viewer = await connect(port)
    const ask = (id: string, method: string, params: unknown) =>
      viewer.client.send(JSON.stringify({ id, method, params }))
    const replied = (id: string) => viewer.messages.some((message) => message.id === id)
    try {
      ask('start', 'thread.start', { provider: 'claude-code', workspacePath: '/work' })
      await vi.waitFor(() =>
        expect(viewer.messages).toContainEqual(
          expect.objectContaining({ id: 'start', result: { threadId: 'claude-code-started' } }),
        ),
      )
      ask('earlier', 'thread.sendTurn', { threadId: 'claude-earlier', text: 'hi' })
      ask('new', 'thread.sendTurn', { threadId: 'claude-code-started', text: 'hi' })
      await vi.waitFor(() => expect(replied('new')).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(replied('earlier')).toBe(false)
      expect(state.historyLoads).toEqual([])

      finishClaude()
      await vi.waitFor(() => expect(replied('earlier')).toBe(true))
      expect(state.historyLoads).toEqual(['claude-earlier'])
    } finally {
      viewer.client.terminate()
    }
  })

  it('merges outside turns into a chat started in this run once a scan linked its session', async () => {
    let finishClaude!: () => void
    state.historyScans.set('claude-code', new Promise<void>((resolve) => (finishClaude = resolve)))
    const { port } = await listen()
    await askForProjects(port)
    await vi.waitFor(() => expect(state.historySources).toHaveLength(1))
    const viewer = await connect(port)
    const ask = (id: string, method: string, params: unknown) =>
      viewer.client.send(JSON.stringify({ id, method, params }))
    const replied = (id: string) => viewer.messages.some((message) => message.id === id)
    try {
      ask('start', 'thread.start', { provider: 'claude-code', workspacePath: '/work' })
      await vi.waitFor(() => expect(replied('start')).toBe(true))
      state.historyCopies.add('claude-code-started')
      ask('second', 'thread.sendTurn', { threadId: 'claude-code-started', text: 'again' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(replied('second')).toBe(false)

      finishClaude()
      await vi.waitFor(() => expect(replied('second')).toBe(true))
      expect(state.historyLoads).toEqual(['claude-code-started'])
    } finally {
      viewer.client.terminate()
    }
  })

  it('imports before reading once the scan is done, as before', async () => {
    state.historyPage.mockResolvedValue(opened)
    const { port } = await listen()
    await askForProjects(port)
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

describe('background startup work', () => {
  it('waits until the first client has its project list', async () => {
    const { port } = await listen()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(state.historySources).toEqual([])
    expect([state.prewarmed, state.recovered]).toEqual([0, 0])

    await askForProjects(port)
    await vi.waitFor(() => expect(state.historySources).toHaveLength(1))
    expect([state.prewarmed, state.recovered]).toEqual([1, 1])

    // Later clients do not start it again.
    await askForProjects(port)
    expect(state.historySources).toHaveLength(1)
    expect([state.prewarmed, state.recovered]).toEqual([1, 1])
  })

  it('starts shortly after listening when no client asks', async () => {
    await listen()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(state.historySources).toEqual([])
    await vi.waitFor(() => expect(state.historySources).toHaveLength(1), { timeout: 2_000 })
    expect([state.prewarmed, state.recovered]).toEqual([1, 1])
  })

  it('starts at once for an imported chat, which needs the scan', async () => {
    state.historyPage.mockResolvedValue({ events: [], page: { olderCursor: null, snapshotSeq: 0 } })
    const { port } = await listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    try {
      await once(client, 'message')
      const reply = once(client, 'message')
      client.send(
        JSON.stringify({
          id: 'imported',
          method: 'thread.history',
          params: { threadId: 'external:codex:s', page: {} },
        }),
      )
      await reply
    } finally {
      client.terminate()
    }
    expect(state.historySources).toHaveLength(1)
    expect(state.historyLoads).toEqual(['external:codex:s'])
  })

  it('never starts once the server closed', async () => {
    await listen()
    await running!.close()
    running = undefined
    await new Promise((resolve) => setTimeout(resolve, 1_700))
    expect(state.historySources).toEqual([])
    expect([state.prewarmed, state.recovered]).toEqual([0, 0])
  })
})

describe("a client's first batch", () => {
  it('answers store reads before the provider reads queued ahead of them', async () => {
    const { port } = await listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    const upgraded = new Promise<Socket>((resolve) => {
      client.once('upgrade', (response) => resolve(response.socket))
    })
    try {
      await once(client, 'message')
      const replies: string[] = []
      const answered = new Promise<void>((resolve) => {
        client.on('message', (raw) => {
          const message: unknown = JSON.parse(String(raw))
          if (message && typeof message === 'object' && 'id' in message) {
            replies.push(String(message.id))
          }
          if (replies.length === 2) resolve()
        })
      })
      // One write, the way the renderer flushes the requests it queued before the socket opened.
      const socket = await upgraded
      socket.cork()
      client.send(
        JSON.stringify({ id: 'auth', method: 'auth.status', params: { provider: 'claude-code' } }),
      )
      client.send(JSON.stringify({ id: 'projects', method: 'projects.list', params: {} }))
      socket.uncork()
      await answered
      // A provider read can load an adapter synchronously; the project list must not wait for it.
      expect(state.handled).toEqual(['projects.list', 'auth.status(claude-code)'])
      expect(replies).toEqual(['projects', 'auth'])
    } finally {
      client.terminate()
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

describe('feedback routes', () => {
  async function ask(port: number, method: string, params: unknown) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    try {
      await once(client, 'message')
      const reply = once(client, 'message')
      client.send(JSON.stringify({ id: 'feedback', method, params }))
      const [message] = await reply
      return JSON.parse(String(message)) as unknown
    } finally {
      client.terminate()
    }
  }
  const draft = {
    kind: 'idea',
    message: 'A darker sidebar would be nice.',
    includeError: false,
    includeDiagnostics: false,
    context: { source: 'command_palette' },
  }

  it('reports a build without an inbox key as disabled', async () => {
    const { port } = await listen()
    expect(await ask(port, 'feedback.status', {})).toEqual({
      id: 'feedback',
      result: { enabled: false, reason: 'not_configured' },
    })
    expect(
      await ask(port, 'feedback.submit', { ...draft, submissionId: crypto.randomUUID() }),
    ).toMatchObject({ result: { ok: false, code: 'not_configured' } })
  })

  it('previews a configured draft without the key and refuses oversize text', async () => {
    running = startServer({
      port: 0,
      feedback: { endpoint: { url: 'https://feedback.test/api/feedback', key: 'fb_test_000' } },
    })
    const listener = state.servers.at(-1)!
    await once(listener, 'listening')
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener address')
    const preview = await ask(address.port, 'feedback.preview', draft)
    expect(preview).toEqual({
      id: 'feedback',
      result: {
        payload: JSON.stringify(
          { kind: 'idea', message: draft.message, metadata: { app: 'TasteCode' } },
          null,
          2,
        ),
        redactions: 0,
      },
    })
    expect(JSON.stringify(preview)).not.toContain('fb_test_000')
    expect(
      await ask(address.port, 'feedback.preview', { ...draft, message: 'x'.repeat(4001) }),
    ).toMatchObject({ error: { code: 'bad_request' } })
  })
})

describe('phone links', () => {
  async function desktopClient(port: number) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages: Array<Record<string, unknown>> = []
    client.on('message', (message) => messages.push(JSON.parse(String(message))))
    await once(client, 'message')
    return { client, messages }
  }

  async function phoneLink(port: number, serverKey: string, hello: Record<string, unknown>) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/link`)
    await once(socket, 'open')
    const initiator = new NoiseInitiator({
      staticKey: generateNoiseKeyPair(),
      remoteStaticKey: Buffer.from(serverKey, 'base64url'),
    })
    const frames: Array<Record<string, unknown>> = []
    // The welcome frame follows the handshake reply at once, so one listener reads both.
    const handshake = new Promise<{ payload: Buffer; session: NoiseSession }>((resolve) => {
      let session: NoiseSession | undefined
      socket.on('message', (data: Buffer) => {
        if (session) {
          frames.push(JSON.parse(session.receive.decrypt(data).toString()))
          return
        }
        const read = initiator.readMessage2(data)
        session = read.session
        resolve(read)
      })
    })
    socket.send(initiator.writeMessage1(Buffer.from(JSON.stringify(hello))))
    const { payload, session } = await handshake
    return { answer: JSON.parse(payload.toString()), socket, session, frames }
  }

  function send(link: { socket: WebSocket; session: NoiseSession }, frame: unknown) {
    link.socket.send(link.session.send.encrypt(Buffer.from(JSON.stringify(frame))))
  }

  it('serves a paired phone the desktop protocol, limited to what a phone may do', async () => {
    vi.stubEnv('HARNESS_PHONE_PORT', '0')
    const { port } = await listen()
    const desktop = await desktopClient(port)
    try {
      desktop.client.send(JSON.stringify({ id: 'pair', method: 'phone.startPairing', params: {} }))
      await vi.waitFor(() =>
        expect(desktop.messages.find((message) => message['id'] === 'pair')).toBeDefined(),
      )
      const reply = desktop.messages.find((message) => message['id'] === 'pair') as {
        result: { status: { port: number }; pairing: { uri: string } }
      }
      const encoded = new URL(reply.result.pairing.uri).searchParams.get('p') ?? ''
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as {
        key: string
        secret: string
      }
      expect(state.credentials.get('phone-link.server-key')).toBeDefined()

      const phone = await phoneLink(reply.result.status.port, payload.key, {
        v: 1,
        name: 'iPhone',
        pair: payload.secret,
      })
      expect(phone.answer).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(phone.frames[0]).toMatchObject({ channel: 'server.welcome' }))
      await vi.waitFor(() =>
        expect(desktop.messages).toContainEqual(
          expect.objectContaining({
            channel: 'phone.changed',
            data: expect.objectContaining({
              devices: [expect.objectContaining({ name: 'iPhone', connected: true })],
            }),
          }),
        ),
      )

      send(phone, { id: 'info', method: 'system.info', params: {} })
      send(phone, { id: 'shell', method: 'terminal.close', params: { terminalId: 't' } })
      send(phone, { id: 'pair', method: 'phone.startPairing', params: {} })
      send(phone, { id: 'rename', method: 'thread.rename', params: { threadId: 't', title: 'x' } })
      await vi.waitFor(() => expect(phone.frames.filter((frame) => 'id' in frame)).toHaveLength(4))
      const answers = Object.fromEntries(
        phone.frames.filter((frame) => 'id' in frame).map((frame) => [frame['id'], frame]),
      )
      expect(answers['info']).toMatchObject({ result: { protocolVersion: expect.any(Number) } })
      expect(answers['shell']).toMatchObject({ error: { code: 'forbidden' } })
      expect(answers['pair']).toMatchObject({ error: { code: 'forbidden' } })
      expect(answers['rename']).toMatchObject({ result: {} })
      expect(state.renamed).toEqual(['t'])
      expect(phone.frames.some((frame) => frame['channel'] === 'phone.changed')).toBe(false)
      phone.socket.terminate()
    } finally {
      desktop.client.terminate()
    }
  })
})
