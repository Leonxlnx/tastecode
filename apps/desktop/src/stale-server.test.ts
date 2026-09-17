import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { PROTOCOL_VERSION } from '@harness/contracts'
import {
  killStaleServerProcess,
  portListenerPids,
  probeCoreServer,
  processExists,
  readServerOwner,
  resolveStaleServer,
  writeServerOwner,
  clearServerOwner,
  type CoreServerProbe,
} from './stale-server.js'

const roots: string[] = []
const servers: { close(): void }[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempFile(name: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stale-server-'))
  roots.push(root)
  return path.join(root, name)
}

/** A ws server that answers each connection with a server.welcome frame. */
function fakeCoreServer(protocolVersion = PROTOCOL_VERSION): Promise<{
  url: string
  wss: WebSocketServer
}> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  servers.push(wss)
  wss.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        channel: 'server.welcome',
        sequence: 1,
        data: { serverVersion: '0.0.0-test', protocolVersion },
      }),
    )
  })
  return new Promise((resolve) => {
    wss.once('listening', () => {
      const port = (wss.address() as AddressInfo).port
      resolve({ url: `ws://127.0.0.1:${port}`, wss })
    })
  })
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('probeCoreServer', () => {
  it('reports free when nothing listens', async () => {
    const port = await freePort()
    expect(await probeCoreServer(`ws://127.0.0.1:${port}`)).toEqual({ status: 'free' })
  })

  it('reports compatible when a core server answers the handshake', async () => {
    const { url } = await fakeCoreServer()
    expect(await probeCoreServer(url)).toEqual({
      status: 'compatible',
      serverVersion: '0.0.0-test',
    })
  })

  it('reports incompatible when the protocol version differs', async () => {
    const { url } = await fakeCoreServer(PROTOCOL_VERSION + 1)
    const probe = await probeCoreServer(url)
    expect(probe).toEqual({
      status: 'incompatible',
      serverVersion: '0.0.0-test',
      protocolVersion: PROTOCOL_VERSION + 1,
    })
  })

  it('reports unresponsive when a listener never completes the handshake', async () => {
    const server = net.createServer(() => {})
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const probe = await probeCoreServer(`ws://127.0.0.1:${port}`, { welcomeTimeoutMs: 300 })
    expect(probe.status).toBe('unresponsive')
  })

  it('reports unresponsive when the first frame is not a welcome', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    servers.push(wss)
    wss.on('connection', (socket) => socket.send('{"channel":"other"}'))
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    const port = (wss.address() as AddressInfo).port
    expect((await probeCoreServer(`ws://127.0.0.1:${port}`)).status).toBe('unresponsive')
  })
})

describe('portListenerPids', () => {
  it('parses netstat -ano output on win32', async () => {
    const run = async () =>
      [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    127.0.0.1:4311         0.0.0.0:0              LISTENING       21844',
        '  TCP    127.0.0.1:5183         0.0.0.0:0              LISTENING       9999',
        '  TCP    127.0.0.1:4311         127.0.0.1:55000        ESTABLISHED     1234',
      ].join('\r\n')
    expect(await portListenerPids(4311, { platform: 'win32', run })).toEqual(new Set([21844]))
  })

  it('parses ss output on linux', async () => {
    const run = async () =>
      'LISTEN 0 511 127.0.0.1:4311 0.0.0.0:* users:(("node",pid=4242,fd=20))\n' +
      'LISTEN 0 511 127.0.0.1:9999 0.0.0.0:* users:(("node",pid=1111,fd=20))\n'
    expect(await portListenerPids(4311, { platform: 'linux', run })).toEqual(new Set([4242]))
  })

  it('falls back to lsof on linux when ss is missing', async () => {
    const enoent = Object.assign(new Error('spawn ss ENOENT'), { code: 'ENOENT' })
    const run = async (command: string) => {
      if (command === 'ss') throw enoent
      return '4242\n777\n'
    }
    expect(await portListenerPids(4311, { platform: 'linux', run })).toEqual(new Set([4242, 777]))
  })

  it('returns an empty set when the platform inventory fails', async () => {
    const run = async () => {
      throw new Error('tool missing')
    }
    expect(await portListenerPids(4311, { platform: 'darwin', run })).toEqual(new Set())
  })

  it('finds a real listener on this machine', async () => {
    const server = net.createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const pids = await portListenerPids(port)
    // On machines without ss/lsof the inventory degrades to empty — the test
    // only asserts attribution wherever the tooling exists.
    if (pids.size > 0) expect(pids.has(process.pid)).toBe(true)
  })
})

describe('server owner record', () => {
  it('round-trips and clears', async () => {
    const file = tempFile('server-owner.json')
    await writeServerOwner(file, { pid: 1234, port: 4311, recordedAt: 1000 })
    expect(await readServerOwner(file)).toEqual({ pid: 1234, port: 4311, recordedAt: 1000 })
    await clearServerOwner(file)
    expect(await readServerOwner(file)).toBeUndefined()
  })

  it('treats a corrupt record as absent', async () => {
    const file = tempFile('server-owner.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'not json{{{')
    expect(await readServerOwner(file)).toBeUndefined()
  })
})

describe('processExists', () => {
  it('sees this process and rejects dead pids', () => {
    expect(processExists(process.pid)).toBe(true)
    expect(processExists(2 ** 22)).toBe(false)
  })
})

describe('killStaleServerProcess', () => {
  it('terminates a foreign process by pid', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    })
    expect(child.pid).toBeDefined()
    await killStaleServerProcess(child.pid!)
    expect(processExists(child.pid!)).toBe(false)
  })
})

describe('resolveStaleServer', () => {
  /** A probe stub returning the given results in order (last one repeats). */
  const probeReturning =
    (...results: CoreServerProbe[]) =>
    async (): Promise<CoreServerProbe> =>
      results.length > 1 ? results.shift()! : results[0]!

  it('spawns when the port is free and no lease is suspected', async () => {
    const kill = vi.fn()
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      probe: probeReturning({ status: 'free' }),
      listenerPids: async () => new Set(),
      kill,
    })
    expect(verdict).toEqual({ kind: 'none' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('adopts a compatible holder instead of killing it', async () => {
    const kill = vi.fn()
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      probe: probeReturning({ status: 'compatible', serverVersion: '0.0.0' }),
      listenerPids: async () => new Set([777]),
      kill,
    })
    expect(verdict).toEqual({ kind: 'adopted', holderPids: [777] })
    expect(kill).not.toHaveBeenCalled()
  })

  it('kills the listeners of a self-identified incompatible server', async () => {
    const kill = vi.fn().mockResolvedValue(undefined)
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      probe: probeReturning({ status: 'incompatible' }, { status: 'free' }),
      listenerPids: async () => new Set([555]),
      kill,
      exists: () => true,
    })
    expect(kill).toHaveBeenCalledWith(555)
    expect(verdict).toEqual({ kind: 'cleared', killedPids: [555] })
  })

  it('spares a recorded pid that is not the incompatible listener', async () => {
    // The recorded pid may have been reused by an unrelated process — an
    // incompatible holder does not prove our orphan is the one on the port.
    const kill = vi.fn().mockResolvedValue(undefined)
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      ownerPid: 4321,
      probe: probeReturning({ status: 'incompatible' }, { status: 'free' }),
      listenerPids: async () => new Set([555]),
      kill,
      exists: () => true,
    })
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(555)
    expect(verdict).toEqual({ kind: 'cleared', killedPids: [555] })
  })

  it('kills a recorded orphan even when it holds only the lease', async () => {
    const kill = vi.fn().mockResolvedValue(undefined)
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      ownerPid: 4321,
      leaseSuspected: true,
      probe: probeReturning({ status: 'free' }),
      listenerPids: async () => new Set(),
      kill,
      exists: (pid) => pid === 4321,
    })
    expect(kill).toHaveBeenCalledWith(4321)
    expect(verdict).toEqual({ kind: 'cleared', killedPids: [4321] })
  })

  it('reports a lease held by a process we cannot attribute', async () => {
    const kill = vi.fn()
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      ownerPid: 4321,
      leaseSuspected: true,
      probe: probeReturning({ status: 'free' }),
      listenerPids: async () => new Set(),
      kill,
      exists: () => false, // recorded pid is long gone — lease is held by a stranger
    })
    expect(verdict).toEqual({ kind: 'blocked', reason: 'lease-held' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('kills an unresponsive holder only when it is our recorded pid', async () => {
    const kill = vi.fn().mockResolvedValue(undefined)
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      ownerPid: 4321,
      probe: probeReturning({ status: 'unresponsive' }, { status: 'free' }),
      listenerPids: async () => new Set([4321, 9000]),
      kill,
      exists: () => true,
    })
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(4321)
    expect(verdict).toEqual({ kind: 'cleared', killedPids: [4321] })
  })

  it('refuses to kill an unresponsive foreign holder', async () => {
    const kill = vi.fn()
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      ownerPid: 4321, // not among the listeners — a different, reused pid
      probe: probeReturning({ status: 'unresponsive' }),
      listenerPids: async () => new Set([9000]),
      kill,
      exists: () => true,
    })
    expect(verdict).toEqual({ kind: 'blocked', reason: 'foreign-listener' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('reports a foreign listener when the kill does not free the port', async () => {
    const kill = vi.fn().mockResolvedValue(undefined)
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      probe: probeReturning({ status: 'incompatible' }),
      listenerPids: async () => new Set([555]),
      kill,
    })
    // Our kill succeeded but something else still holds the port.
    expect(verdict).toEqual({ kind: 'blocked', reason: 'foreign-listener' })
  })

  it('reports kill-failed when every termination rejects', async () => {
    const kill = vi.fn().mockRejectedValue(new Error('denied'))
    const verdict = await resolveStaleServer({
      url: 'ws://127.0.0.1:4311',
      probe: probeReturning({ status: 'incompatible' }),
      listenerPids: async () => new Set([555]),
      kill,
    })
    expect(verdict).toEqual({ kind: 'blocked', reason: 'kill-failed' })
  })

  it('clears a real orphaned server process end to end', async () => {
    const port = await freePort()
    // An incompatible "old version" server, standing in for a real orphan: a
    // detached child of this test process answering with a wrong protocol.
    const script = [
      'const { WebSocketServer } = require("ws")',
      `const wss = new WebSocketServer({ port: ${port}, host: "127.0.0.1" })`,
      'wss.on("connection", (s) => s.send(JSON.stringify({',
      '  channel: "server.welcome", sequence: 1,',
      `  data: { serverVersion: "old", protocolVersion: ${PROTOCOL_VERSION + 1} } })))`,
      'wss.on("listening", () => console.log("ready"))',
    ].join('\n')
    const child = spawn(process.execPath, ['-e', script], {
      windowsHide: true,
      // `ws` resolves from the desktop package's own node_modules.
      cwd: path.dirname(fileURLToPath(import.meta.url)),
    })
    servers.push({ close: () => child.kill('SIGKILL') })
    await new Promise<void>((resolve) => {
      child.stdout!.once('data', () => resolve())
      child.once('exit', () => resolve())
    })
    expect((await probeCoreServer(`ws://127.0.0.1:${port}`)).status).toBe('incompatible')

    const verdict = await resolveStaleServer({ url: `ws://127.0.0.1:${port}` })
    // Platforms without a port inventory (no ss/lsof/netstat) cannot attribute
    // the holder — they report blocked instead, which is the safe outcome.
    if ((await portListenerPids(port)).size === 0 && verdict.kind === 'blocked') return
    expect(verdict.kind).toBe('cleared')
    expect(processExists(child.pid!)).toBe(false)
    expect((await probeCoreServer(`ws://127.0.0.1:${port}`)).status).toBe('free')
  })
})
