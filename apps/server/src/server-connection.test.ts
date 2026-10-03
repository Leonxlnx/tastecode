import { once } from 'node:events'
import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, type ServerOptions, type WebSocketServer } from 'ws'
import { startServer } from './server.js'

const state = vi.hoisted(() => ({ servers: [] as WebSocketServer[] }))

// Exercise the real listener without opening user data or starting providers.
vi.mock('./data-location.js', () => ({ storeLocation: () => ':memory:' }))
vi.mock('./data-lease.js', () => ({ acquireDataLease: () => () => undefined }))
vi.mock('@harness/proc/desktop-path', () => ({ applyDesktopPath: () => undefined }))
vi.mock('./store.js', () => ({
  Store: class {
    recoverInterruptedThreads() {}
    nextLifecycleRefreshAt() {}
    close() {}
  },
}))
vi.mock('./orchestrator.js', () => ({
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
