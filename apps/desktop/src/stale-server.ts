import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { PROTOCOL_VERSION } from '@harness/contracts'
import { killTree, type KillableProcess } from '@harness/proc/kill'

/**
 * Stale-server detection for the supervised core server.
 *
 * When the Electron main process dies hard (SIGKILL, crash), the supervised
 * server survives as an orphan that still holds the listen port and the SQLite
 * data lease. The next launch then fails EADDRINUSE / lease-held and the
 * supervisor would restart into a wall — or worse, the renderer could connect
 * to the stale server (old version, old environment).
 *
 * The port holder is probed before spawning: a server that answers the
 * WebSocket handshake and identifies itself with `server.welcome` at a
 * compatible PROTOCOL_VERSION is adopted (the renderer connects to it anyway);
 * anything else is killed only when it can be attributed — either because it
 * self-identified as a core server on the port, or because its pid both
 * matches the owner record written at spawn time and is provably the listener
 * (or the lease holder). Killing by pid alone is never done on a guess: pids
 * get reused, and a foreign process squatting on the port is reported to the
 * user instead of being terminated.
 */

const TCP_PROBE_TIMEOUT_MS = 750
const WELCOME_TIMEOUT_MS = 1_500
const EXEC_MAX_BUFFER = 8 * 1024 * 1024

const execFileAsync = promisify(execFile)

export type CoreServerProbe =
  /** Nothing listens on the port. */
  | { status: 'free' }
  /** A `server.welcome` frame arrived with our PROTOCOL_VERSION. */
  | { status: 'compatible'; serverVersion?: string | undefined }
  /** A `server.welcome` frame arrived with a different protocol version. */
  | {
      status: 'incompatible'
      serverVersion?: string | undefined
      protocolVersion?: number | undefined
    }
  /** Something accepts TCP but never produced a valid welcome frame. */
  | { status: 'unresponsive' }

/** The slice of the browser-style WebSocket the probe needs (undici global). */
export type ProbeSocket = {
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
    options?: { once?: boolean },
  ): void
  addEventListener(
    type: 'error' | 'close',
    listener: () => void,
    options?: { once?: boolean },
  ): void
  close(): void
}

type ProbeSocketCtor = new (url: string) => ProbeSocket

export async function probeCoreServer(
  url: string,
  options: {
    tcpTimeoutMs?: number
    welcomeTimeoutMs?: number
    WebSocketCtor?: ProbeSocketCtor
  } = {},
): Promise<CoreServerProbe> {
  const target = new URL(url)
  const reachable = await tcpReachable(
    target.hostname,
    Number(target.port),
    options.tcpTimeoutMs ?? TCP_PROBE_TIMEOUT_MS,
  )
  if (reachable === 'refused') return { status: 'free' }
  if (reachable === 'stalled') return { status: 'unresponsive' }
  return welcomeProbe(
    url,
    options.welcomeTimeoutMs ?? WELCOME_TIMEOUT_MS,
    options.WebSocketCtor ?? WebSocket,
  )
}

/**
 * A refused loopback connection means nothing listens — every other failure
 * (including a stalled connect, which happens when a wedged listener's backlog
 * is full) means something might be there.
 */
function tcpReachable(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<'open' | 'refused' | 'stalled'> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (result: 'open' | 'refused' | 'stalled') => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish('open'))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'refused' : 'stalled')
    })
    timer = setTimeout(() => finish('stalled'), timeoutMs)
  })
}

function welcomeProbe(
  url: string,
  timeoutMs: number,
  WebSocketCtor: ProbeSocketCtor,
): Promise<CoreServerProbe> {
  return new Promise((resolve) => {
    let socket: ProbeSocket | undefined
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (result: CoreServerProbe) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        // Closing a half-open socket can throw; the probe is over either way.
      }
      resolve(result)
    }
    try {
      socket = new WebSocketCtor(url)
    } catch {
      finish({ status: 'unresponsive' })
      return
    }
    timer = setTimeout(() => finish({ status: 'unresponsive' }), timeoutMs)
    socket.addEventListener('message', (event) => finish(classifyWelcome(event.data)), {
      once: true,
    })
    socket.addEventListener('error', () => finish({ status: 'unresponsive' }), { once: true })
    socket.addEventListener('close', () => finish({ status: 'unresponsive' }), { once: true })
  })
}

/** Only a `server.welcome` frame proves the peer is a TasteCode core server. */
function classifyWelcome(data: unknown): CoreServerProbe {
  if (typeof data !== 'string') return { status: 'unresponsive' }
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    return { status: 'unresponsive' }
  }
  if (typeof frame !== 'object' || frame === null) return { status: 'unresponsive' }
  const channel = (frame as { channel?: unknown }).channel
  if (channel !== 'server.welcome') return { status: 'unresponsive' }
  const payload = (frame as { data?: unknown }).data
  if (typeof payload !== 'object' || payload === null) return { status: 'unresponsive' }
  const serverVersion = (payload as { serverVersion?: unknown }).serverVersion
  const protocolVersion = (payload as { protocolVersion?: unknown }).protocolVersion
  const identity = {
    serverVersion: typeof serverVersion === 'string' ? serverVersion : undefined,
    protocolVersion: typeof protocolVersion === 'number' ? protocolVersion : undefined,
  }
  return identity.protocolVersion === PROTOCOL_VERSION
    ? { status: 'compatible', serverVersion: identity.serverVersion }
    : { status: 'incompatible', ...identity }
}

/**
 * Pids listening on a TCP port, using the platform inventory. The same trio of
 * sources as tools/scripts/dev.js: netstat on Windows, ss on Linux, lsof as the
 * POSIX fallback. A missing tool or unreadable output yields an empty set —
 * callers treat that as "cannot attribute", never as "safe to kill".
 */
export async function portListenerPids(
  port: number,
  options: {
    platform?: NodeJS.Platform
    run?: (command: string, args: string[]) => Promise<string>
  } = {},
): Promise<Set<number>> {
  const platform = options.platform ?? process.platform
  const run = options.run ?? runCommand
  try {
    if (platform === 'win32') {
      return parseNetstatListeners(await run('netstat.exe', ['-ano', '-p', 'tcp']), port)
    }
    if (platform === 'linux') {
      try {
        return parseSsListeners(await run('ss', ['-H', '-ltnp']), port)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
    return parseLsofListeners(await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']))
  } catch {
    return new Set()
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true,
    maxBuffer: EXEC_MAX_BUFFER,
  })
  return stdout
}

function parseNetstatListeners(output: string, port: number): Set<number> {
  const pids = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || fields[0]!.toUpperCase() !== 'TCP') continue
    if (fields[3]!.toUpperCase() !== 'LISTENING') continue
    if (Number.parseInt(fields[1]!.match(/:(\d+)$/)?.[1] ?? '', 10) !== port) continue
    const pid = Number.parseInt(fields[4]!, 10)
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return pids
}

function parseSsListeners(output: string, port: number): Set<number> {
  const pids = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || fields[0]!.toUpperCase() !== 'LISTEN') continue
    if (Number.parseInt(fields[3]!.match(/:(\d+)$/)?.[1] ?? '', 10) !== port) continue
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number.parseInt(match[1]!, 10)
      if (pid > 0) pids.add(pid)
    }
  }
  return pids
}

function parseLsofListeners(output: string): Set<number> {
  const pids = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10)
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return pids
}

/**
 * The desktop records the pid of every supervised server it spawns. On the next
 * launch the record is what distinguishes "our orphan, safe to reap" from "a
 * stranger's process that happens to sit on the port". It is only ever a hint —
 * `portListenerPids` still verifies attribution before anything is killed.
 */
export type ServerOwnerRecord = {
  pid: number
  port: number
  recordedAt: number
}

export async function readServerOwner(file: string): Promise<ServerOwnerRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { pid?: unknown; port?: unknown; recordedAt?: unknown }
    if (typeof record.pid !== 'number' || typeof record.port !== 'number') return undefined
    return {
      pid: record.pid,
      port: record.port,
      recordedAt: typeof record.recordedAt === 'number' ? record.recordedAt : 0,
    }
  } catch {
    return undefined
  }
}

export async function writeServerOwner(file: string, owner: ServerOwnerRecord): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(owner), { mode: 0o600 })
  } catch {
    // Ownership bookkeeping must never break a launch.
  }
}

export async function clearServerOwner(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => undefined)
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM still means the pid is alive — just not signalable by us.
    return errorCode(error) === 'EPERM'
  }
}

/**
 * Terminate a process that is not our child. `killTree` needs a KillableProcess,
 * so the foreign pid is adapted: `exitCode` reports dead-vs-alive through a
 * `kill(pid, 0)` probe, which gives the bounded TERM → KILL escalation its
 * stop condition. On Windows taskkill /T /F takes the whole tree; elsewhere the
 * server gets TERM first precisely so its own shutdown (which disposes provider
 * children) can run before KILL.
 */
export function killStaleServerProcess(pid: number): Promise<void> {
  const orphan: KillableProcess = {
    pid,
    get exitCode() {
      return processExists(pid) ? null : 0
    },
    get signalCode() {
      return null
    },
    kill: (signal?: number | NodeJS.Signals) => {
      try {
        return process.kill(pid, signal ?? 'SIGTERM')
      } catch {
        return false
      }
    },
  }
  return killTree(orphan)
}

export type StaleServerVerdict =
  /** Nothing blocks startup — go ahead and spawn. */
  | { kind: 'none' }
  /** A compatible core server is already running — connect, don't spawn. */
  | { kind: 'adopted'; holderPids: number[] }
  /** The blocker was attributable and is now gone — spawn again. */
  | { kind: 'cleared'; killedPids: number[] }
  /** Something is blocking and cannot be safely removed — tell the user. */
  | {
      kind: 'blocked'
      reason: 'incompatible-server' | 'foreign-listener' | 'lease-held' | 'kill-failed'
    }

export type StaleServerDeps = {
  probe?: typeof probeCoreServer
  listenerPids?: (port: number) => Promise<Set<number>>
  kill?: (pid: number) => Promise<void>
  exists?: (pid: number) => boolean
  log?: (line: string) => void
}

/**
 * Resolve whatever currently blocks the supervised server. `ownerPid` is the
 * pid recorded for the previously spawned server; `leaseSuspected` marks the
 * case where the last run died on the data lease while the port itself is
 * free (a wedged orphan can hold the lease without ever binding the port, and
 * so can a running history-maintenance command).
 */
export async function resolveStaleServer(
  options: {
    url: string
    ownerPid?: number | undefined
    leaseSuspected?: boolean
  } & StaleServerDeps,
): Promise<StaleServerVerdict> {
  const probe = options.probe ?? probeCoreServer
  const listenerPids = options.listenerPids ?? portListenerPids
  const kill = options.kill ?? killStaleServerProcess
  const exists = options.exists ?? processExists
  const log = options.log ?? (() => {})
  const port = Number(new URL(options.url).port)

  const probeResult = await probe(options.url)
  if (probeResult.status === 'compatible') {
    log(`a compatible core server already answers on ${options.url} — adopting it`)
    return { kind: 'adopted', holderPids: [...(await listenerPids(port))] }
  }
  if (probeResult.status === 'free' && !options.leaseSuspected) return { kind: 'none' }

  const holderPids = await listenerPids(port)
  const victims = new Set<number>()
  if (probeResult.status === 'incompatible') {
    // The listener self-identified as a core server — just an incompatible one.
    for (const pid of holderPids) victims.add(pid)
  }
  if (options.ownerPid !== undefined && exists(options.ownerPid)) {
    const ours =
      // A live recorded orphan is stale by definition once the lease is
      // suspected — a healthy one would have answered the probe and been
      // adopted above. Reaping it frees the lease even when a foreign
      // process still holds the port.
      options.leaseSuspected === true || holderPids.has(options.ownerPid) // provably the port owner
    if (ours) victims.add(options.ownerPid)
  }
  if (victims.size === 0) {
    return {
      kind: 'blocked',
      reason:
        probeResult.status === 'free'
          ? 'lease-held'
          : probeResult.status === 'incompatible'
            ? 'incompatible-server'
            : 'foreign-listener',
    }
  }
  const results = await Promise.allSettled([...victims].map((pid) => kill(pid)))
  const victimList = [...victims]
  const killedPids = victimList.filter((_, index) => results[index]!.status === 'fulfilled')
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      log(`stale server pid ${victimList[index]} did not stop: ${String(result.reason)}`)
    }
  }
  if (killedPids.length === 0) return { kind: 'blocked', reason: 'kill-failed' }
  // Confirm the port actually freed — the blocker may have been a different pid.
  const after = await probe(options.url)
  return after.status === 'free'
    ? { kind: 'cleared', killedPids }
    : { kind: 'blocked', reason: 'foreign-listener' }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
