import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, type ServerOptions, type WebSocketServer } from 'ws'
import { startServer } from './server.js'

const state = vi.hoisted(() => ({
  servers: [] as WebSocketServer[],
  projects: [] as Array<{ path: string }>,
  threads: new Map<string, { projectPath: string; worktreePath?: string }>(),
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
    close() {}
  },
}))
vi.mock('./orchestrator.js', () => ({
  resolveWorkspacePath: (workspace: string) => workspace,
  Orchestrator: class {
    async protectStoredCheckpoints() {}
    refreshLifecycle() {}
    async recoverWorktrees() {}
    async disposeAll() {}
  },
}))
vi.mock('./providers.js', () => ({ prewarmProviders: () => undefined }))
vi.mock('./provider-history.js', () => ({
  ProviderHistory: class {
    async refresh() {}
    async close() {}
  },
}))
vi.mock('@harness/adapter-codex', () => ({ createCodexHistorySource: () => ({}) }))
vi.mock('@harness/adapter-claude-code', () => ({ createClaudeHistorySource: () => ({}) }))
vi.mock('@harness/adapter-grok', () => ({ createGrokHistorySource: () => ({}) }))
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
