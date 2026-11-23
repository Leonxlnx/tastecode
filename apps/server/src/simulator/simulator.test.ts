import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { SIMULATOR_HUB_ROUTE_PREFIX } from '@harness/contracts'
import {
  agentDeviceConfigPath,
  agentDeviceQuickStart,
  agentDeviceSessionId,
  bindAgentDeviceLauncher,
  writeAgentDeviceConfig,
} from './agent-shim.js'
import { LocalSimulatorHost } from './host.js'
import { MjpegStillFrameTransform } from './mjpeg-still-frame.js'
import {
  SIMULATOR_MCP_PATH,
  SIMULATOR_MCP_SERVER_ID,
  SIMULATOR_AGENT_INSTRUCTIONS,
  SimulatorMcpServer,
  pngDimensions,
} from './mcp.js'
import { createSimulatorHubProxy } from './proxy.js'
import { SimulatorService } from './service.js'
import { Orchestrator } from '../orchestrator.js'
import { McpConfigStore } from '../mcp-config.js'
import { Store } from '../store.js'
import type { AgentSession, StartOptions } from '../adapters.js'

const tempDirs: string[] = []
const closeables: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const close of closeables.splice(0).reverse()) {
    await close()
  }
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  )
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tastecode-sim-test-'))
  tempDirs.push(dir)
  return dir
}

function tinyPng(width: number, height: number): Uint8Array {
  const buf = Buffer.alloc(24)
  buf.writeUInt32BE(0x89504e47, 0)
  buf.writeUInt32BE(0x0d0a1a0a, 4)
  buf.writeUInt32BE(13, 8)
  buf.writeUInt32BE(0x49484452, 12)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return new Uint8Array(buf)
}

function listenHttp(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  return new Promise<{ server: ReturnType<typeof createServer>; port: number; origin: string }>(
    (resolve, reject) => {
      const server = createServer(handler)
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') return reject(new Error('missing address'))
        closeables.push(
          () =>
            new Promise<void>((done) => {
              server.closeAllConnections()
              server.close(() => done())
            }),
        )
        resolve({ server, port: addr.port, origin: `http://127.0.0.1:${addr.port}` })
      })
    },
  )
}

describe('MjpegStillFrameTransform', () => {
  it('repeats the final complete multipart frame after a quiet period', async () => {
    const transform = new MjpegStillFrameTransform(20)
    const received: Buffer[] = []
    transform.on('data', (chunk: Buffer) => received.push(Buffer.from(chunk)))

    const body = Buffer.from('FAKEJPEG')
    const part = Buffer.concat([
      Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`),
      body,
      Buffer.from('\r\n'),
    ])
    transform.write(part)
    expect(received).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(received.length).toBeGreaterThanOrEqual(2)
    expect(Buffer.concat(received.slice(1)).equals(part)).toBe(true)
    transform.end()
  })
})

describe('agent-shim', () => {
  it('writes config with restricted permissions and generates a launcher that blocks managed commands', async () => {
    const root = await makeTempDir()
    const configPath = agentDeviceConfigPath(root, 'local')
    await writeAgentDeviceConfig(configPath, {
      baseUrl: 'http://127.0.0.1:44123',
      token: 'secret-daemon-token',
    })
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, string>
    expect(saved).toEqual({
      daemonBaseUrl: 'http://127.0.0.1:44123',
      daemonAuthToken: 'secret-daemon-token',
    })
    if (process.platform !== 'win32') {
      const mode = (await stat(configPath)).mode & 0o777
      expect(mode).toBe(0o600)
    }

    const fakeEntry = path.join(root, 'fake-entry.mjs')
    const session = agentDeviceSessionId('thread-1', 'UDID-1')
    const launcher = await bindAgentDeviceLauncher({
      dataRoot: root,
      entryPath: fakeEntry,
      session,
      targetArgs: [
        '--platform',
        'ios',
        '--udid',
        'UDID-1',
        '--config',
        configPath,
        '--session',
        session,
      ],
    })
    const quickStart = agentDeviceQuickStart(
      {
        id: 'UDID-1',
        name: 'iPhone 17 Pro',
        platform: 'ios',
        version: 'iOS 27.0',
        booted: true,
        physical: false,
      },
      launcher,
    )
    expect(quickStart).toContain(launcher)
    expect(quickStart).toContain('snapshot -i')
  })
})

describe('SimulatorHubProxy security and allowlist', () => {
  it('enforces tickets, origin rules, and route allowlists, and strips tickets upstream', async () => {
    const root = await makeTempDir()
    const seenUrls: string[] = []
    const upstream = await listenHttp((req, res) => {
      seenUrls.push(req.url ?? '')
      if (req.url?.startsWith('/vendor/serve-sim/api')) {
        res
          .writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': 'http://127.0.0.1:59999',
          })
          .end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(200).end('ok')
    })

    // Attach an echo WebSocket on upstream /vendor/serve-sim/helper/ws
    const upstreamWss = new WebSocketServer({ noServer: true })
    upstream.server.on('upgrade', (req, socket, head) => {
      seenUrls.push(`WS:${req.url ?? ''}`)
      upstreamWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }))
      })
    })
    closeables.push(() => upstreamWss.close())

    let storedSettings: string | undefined = JSON.stringify({
      enabled: true,
      agentAccessEnabled: false,
      onboardingCompleted: true,
    })
    const host = new LocalSimulatorHost(root)
    vi.spyOn(host, 'current').mockReturnValue({
      origin: upstream.origin,
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      agentDevice: null,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })

    const service = new SimulatorService({
      dataRoot: root,
      settings: {
        read: () => storedSettings,
        write: (value) => {
          storedSettings = value
        },
      },
      serverOrigin: () => ({
        httpOrigin: 'http://127.0.0.1:4311',
        wsOrigin: 'ws://127.0.0.1:4311',
      }),
      host,
    })

    const proxy = createSimulatorHubProxy({
      simulator: service,
      allowedOrigin: (origin) =>
        origin === undefined || origin === 'http://127.0.0.1:5183' || origin === 'file://',
    })
    closeables.push(() => proxy.close())

    const gateway = await listenHttp((req, res) => {
      void proxy.handleHttp(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
    })
    gateway.server.on('upgrade', (req, socket, head) => {
      proxy.handleUpgrade(req, socket, head)
    })

    const access = service.mintHubAccess()

    // 1. Missing ticket rejected
    const noTicket = await fetch(
      `${gateway.origin}${SIMULATOR_HUB_ROUTE_PREFIX}/vendor/serve-sim/api`,
    )
    expect(noTicket.status).toBe(401)

    // 2. Evil origin rejected even with valid ticket
    const evilOrigin = await fetch(
      `${gateway.origin}${SIMULATOR_HUB_ROUTE_PREFIX}/vendor/serve-sim/api?ticket=${access.ticket}`,
      { headers: { origin: 'https://evil.example' } },
    )
    expect(evilOrigin.status).toBe(401)

    // 3. Disallowed serve-sim exec route blocked with 404
    const execRoute = await fetch(
      `${gateway.origin}${SIMULATOR_HUB_ROUTE_PREFIX}/vendor/serve-sim/api/exec?ticket=${access.ticket}`,
      { method: 'POST', headers: { origin: 'http://127.0.0.1:5183' } },
    )
    expect(execRoute.status).toBe(404)

    // 4. Allowed route succeeds and strips ticket upstream
    const okRes = await fetch(
      `${gateway.origin}${SIMULATOR_HUB_ROUTE_PREFIX}/vendor/serve-sim/api?device=SIM1&ticket=${access.ticket}`,
      { headers: { origin: 'http://127.0.0.1:5183' } },
    )
    expect(okRes.status).toBe(200)
    expect(okRes.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5183')
    expect(seenUrls).toContain('/vendor/serve-sim/api?device=SIM1')
    expect(seenUrls.some((url) => url.includes(access.ticket))).toBe(false)

    // 5. Electron file:// fetch sends Origin: null — allowed ONLY with valid ticket
    const nullOriginRes = await fetch(
      `${gateway.origin}${SIMULATOR_HUB_ROUTE_PREFIX}/vendor/serve-sim/api?ticket=${access.ticket}`,
      { headers: { origin: 'null' } },
    )
    expect(nullOriginRes.status).toBe(200)
    expect(nullOriginRes.headers.get('access-control-allow-origin')).toBe('*')

    // 6. WebSocket upgrade proxies binary frames and strips ticket
    const ws = new WebSocket(
      `ws://127.0.0.1:${gateway.port}${SIMULATOR_HUB_ROUTE_PREFIX}/vendor/serve-sim/helper/ws?device=SIM1&ticket=${access.ticket}`,
      { origin: 'http://127.0.0.1:5183' },
    )
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      ws.once('error', reject)
      ws.once('open', () => ws.send(Buffer.from([0x03, 0x7b, 0x7d])))
      ws.once('message', (data) => resolve(Buffer.from(data as Buffer)))
    })
    ws.close()
    expect(echoed).toEqual(Buffer.from([0x03, 0x7b, 0x7d]))
    expect(seenUrls).toContain('WS:/vendor/serve-sim/helper/ws?device=SIM1')
  })
})

describe('SimulatorMcpServer', () => {
  it('authenticates per-thread tokens, blocks browser origins, and serves the 4 device tools', async () => {
    const root = await makeTempDir()
    const fakeDevice = {
      id: 'SIM-IOS-1',
      name: 'iPhone 17 Pro',
      platform: 'ios' as const,
      version: 'iOS 27.0',
      booted: true,
      physical: false,
    }
    const openedEvents: unknown[] = []
    const host = new LocalSimulatorHost(root)
    vi.spyOn(host, 'summary').mockResolvedValue({
      platforms: [
        { platform: 'ios', available: true },
        { platform: 'android', available: false, reason: 'missing' },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
      tools: {
        hub: { requiredVersion: '0.22.1', installedVersions: ['0.22.1'], runningVersion: '0.22.1' },
        agent: {
          requiredVersion: '0.21.36',
          installedVersions: ['0.21.36'],
          runningVersion: '0.21.36',
        },
      },
    })
    vi.spyOn(host, 'ensureReady').mockResolvedValue({
      origin: 'http://127.0.0.1:49999',
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      agentDevice: null,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    vi.spyOn(host, 'ensureAgentReady').mockResolvedValue({
      origin: 'http://127.0.0.1:49999',
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      agentDevice: {
        baseUrl: 'http://127.0.0.1:49998',
        token: 'daemon-tok',
        entryPath: path.join(root, 'agent-device.mjs'),
      },
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    vi.spyOn(host, 'listDevices').mockResolvedValue({ devices: [fakeDevice] })
    vi.spyOn(host, 'attachDevice').mockResolvedValue(undefined)
    vi.spyOn(host, 'screenshotDevice').mockResolvedValue(tinyPng(390, 844))
    const releaseSpy = vi.spyOn(host, 'releaseAgentSession').mockResolvedValue(undefined)

    let settingsRaw: string | undefined = JSON.stringify({
      enabled: true,
      agentAccessEnabled: true,
      onboardingCompleted: true,
    })
    const service = new SimulatorService({
      dataRoot: root,
      settings: {
        read: () => settingsRaw,
        write: (value) => {
          settingsRaw = value
        },
      },
      serverOrigin: () => ({
        httpOrigin: 'http://127.0.0.1:4311',
        wsOrigin: 'ws://127.0.0.1:4311',
      }),
      onOpened: (event) => openedEvents.push(event),
      host,
    })

    let serverOrigin = ''
    const mcp = new SimulatorMcpServer(service, () => serverOrigin)
    const listener = await listenHttp((req, res) => {
      void mcp.handleHttp(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
    })
    serverOrigin = listener.origin

    const injected = mcp.mcpConfigForThread('pending-1')
    expect(injected?.server.id).toBe(SIMULATOR_MCP_SERVER_ID)
    mcp.rebindThread('pending-1', 'thread-real')
    const authHeader = Object.values(injected!.credentials)[0]!

    // Origin header is strictly refused
    const withOrigin = await fetch(`${listener.origin}${SIMULATOR_MCP_PATH}`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5183',
        authorization: authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(withOrigin.status).toBe(403)

    // Missing token refused
    const unauth = await fetch(`${listener.origin}${SIMULATOR_MCP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(unauth.status).toBe(401)

    const rpc = async (method: string, params?: unknown) => {
      const res = await fetch(`${listener.origin}${SIMULATOR_MCP_PATH}`, {
        method: 'POST',
        headers: {
          authorization: authHeader,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      expect(res.status).toBe(200)
      return (await res.json()) as { result: Record<string, unknown> }
    }

    const init = await rpc('initialize', { protocolVersion: '2025-03-26' })
    expect(init.result['protocolVersion']).toBe('2025-03-26')

    const listedTools = await rpc('tools/list')
    const toolNames = (listedTools.result['tools'] as Array<{ name: string }>).map((t) => t.name)
    expect(toolNames).toEqual(['device_list', 'device_open', 'device_screenshot', 'device_close'])

    // device_list
    const devList = await rpc('tools/call', { name: 'device_list', arguments: {} })
    expect(devList.result['isError']).toBe(false)
    expect((devList.result['structuredContent'] as { devices: unknown[] }).devices).toHaveLength(1)

    // device_open
    const devOpen = await rpc('tools/call', {
      name: 'device_open',
      arguments: { deviceId: 'SIM-IOS-1' },
    })
    expect(devOpen.result['isError']).toBe(false)
    const openPayload = devOpen.result['structuredContent'] as {
      agentDevice: { command: string; session: string }
      quickStart: string
    }
    expect(openPayload.agentDevice.command).toContain('agent-device')
    expect(openPayload.quickStart).toContain('iPhone 17 Pro')
    expect(openedEvents).toEqual([
      {
        threadId: 'thread-real',
        deviceId: 'SIM-IOS-1',
        platform: 'ios',
        name: 'iPhone 17 Pro',
        openedBy: 'agent',
      },
    ])

    // device_screenshot returns image block + dimensions
    const shot = await rpc('tools/call', { name: 'device_screenshot', arguments: {} })
    expect(shot.result['isError']).toBe(false)
    const content = shot.result['content'] as Array<{
      type: string
      mimeType?: string
      data?: string
    }>
    const imageBlock = content.find((block) => block.type === 'image')
    expect(imageBlock?.mimeType).toBe('image/png')
    expect(pngDimensions(Buffer.from(imageBlock!.data!, 'base64'))).toEqual({
      width: 390,
      height: 844,
    })

    // device_close releases agent-device session
    const closed = await rpc('tools/call', { name: 'device_close', arguments: {} })
    expect(closed.result['isError']).toBe(false)
    expect(releaseSpy).toHaveBeenCalledWith(openPayload.agentDevice.session)
    expect(service.sessionsForThread('thread-real')).toEqual([])
  })
})

describe('Orchestrator simulator agent injection', () => {
  it('injects the simulator MCP server and instructions, rebinds the thread token, and hides it from user MCP inventory', async () => {
    const root = await makeTempDir()
    const workspace = await makeTempDir()
    const store = new Store(':memory:')
    closeables.push(() => store.close())

    const receivedStarts: StartOptions[] = []
    const rebound: Array<[string, string]> = []
    const closedThreads: string[] = []

    const fakeSession: AgentSession = {
      capabilities: {
        steer: false,
        fork: false,
        interrupt: true,
        reasoningItems: false,
        approvals: false,
        images: false,
      },
      sendTurn: async () => 'turn-1',
      interrupt: async () => undefined,
      respondToApproval: () => undefined,
      listMcpServers: async () => [
        {
          id: SIMULATOR_MCP_SERVER_ID,
          scope: 'global',
          enabled: true,
          auth: { status: 'not_required' },
          startup: { state: 'ready' },
          tools: [],
          resources: [],
          resourceTemplates: [],
        },
        {
          id: 'user-server',
          scope: 'global',
          enabled: true,
          auth: { status: 'not_required' },
          startup: { state: 'ready' },
          tools: [],
          resources: [],
          resourceTemplates: [],
        },
      ],
      dispose: async () => undefined,
      on: () => undefined,
    }

    const orchestrator = new Orchestrator(store, {
      onEvent: () => undefined,
      onLog: () => undefined,
      onLogin: () => undefined,
      mcpConfig: new McpConfigStore(path.join(root, 'mcp.json')),
      simulatorAgent: {
        serverId: SIMULATOR_MCP_SERVER_ID,
        instructions: SIMULATOR_AGENT_INSTRUCTIONS,
        mcpConfigForThread: (threadId) => ({
          server: {
            id: SIMULATOR_MCP_SERVER_ID,
            enabled: true,
            transport: {
              type: 'http',
              url: 'http://127.0.0.1:4311/mcp',
              headers: {
                Authorization: { source: 'credential', credentialRef: `sim:${threadId}` },
              },
            },
          },
          credentials: { [`sim:${threadId}`]: 'Bearer test-token' },
        }),
        rebindThread: (fromId, toThreadId) => rebound.push([fromId, toThreadId]),
        onThreadClosed: (threadId) => closedThreads.push(threadId),
      },
      runtimeFor: () => ({
        start: async (cwd, options) => {
          receivedStarts.push(options)
          return {
            thread: {
              id: 'codex-real-123',
              provider: 'codex',
              workspacePath: cwd,
              title: 'New session',
              createdAt: Date.now(),
            },
            session: fakeSession,
          }
        },
        listModels: async () => [],
      }),
    })
    closeables.push(() => orchestrator.disposeAll())

    const thread = await orchestrator.startThread('codex', workspace, {})
    expect(thread.id).toBe('codex-real-123')
    expect(receivedStarts).toHaveLength(1)
    expect(receivedStarts[0]?.mcpServers?.map((server) => server.id)).toContain(
      SIMULATOR_MCP_SERVER_ID,
    )
    expect(receivedStarts[0]?.instructions).toContain('device_open')
    expect(rebound).toHaveLength(1)
    expect(rebound[0]?.[1]).toBe('codex-real-123')

    const inventory = await orchestrator.listMcpServers('codex', workspace)
    expect(inventory.servers.map((server) => server.id)).not.toContain(SIMULATOR_MCP_SERVER_ID)
    expect(inventory.servers.map((server) => server.id)).toContain('user-server')

    await orchestrator.close(thread.id)
    expect(closedThreads).toContain('codex-real-123')
  })
})
