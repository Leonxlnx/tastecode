import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'

export type KillableProcess = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'pid' | 'kill'>

const ownedUnixProcessGroups = new WeakSet<object>()
const ownedLinuxPtySessions = new WeakMap<object, LinuxProcessIdentity>()
const PTY_SESSION_SETUP_TIMEOUT_MS = 250
const PTY_SESSION_SETUP_POLL_MS = 5

type PtyProcess = {
  pid: number
  kill(signal?: string): void
}

type LinuxProcessIdentity = {
  pid: number
  parentId: number
  groupId: number
  sessionId: number
  startTime: string
  uid: number
}

/**
 * Spawn options for a process tree that TasteCode owns.
 *
 * A detached Unix child becomes the leader of a new process group. Keeping the
 * ownership marker separate prevents negative-PID signals from ever targeting
 * an arbitrary child that joined the app's own group.
 */
export function ownedProcessSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): Pick<SpawnOptions, 'detached'> {
  return { detached: platform !== 'win32' }
}

export function ownProcessTree<T extends KillableProcess>(
  child: T,
  platform: NodeJS.Platform = process.platform,
): T {
  if (platform !== 'win32' && validProcessGroupId(child.pid)) ownedUnixProcessGroups.add(child)
  return child
}

/** Record the kernel session that a freshly spawned Linux PTY owns. */
export function ownPtySession<T extends PtyProcess>(pty: T): T {
  if (process.platform !== 'linux') return pty
  const identity = readLinuxProcessIdentity(pty.pid)
  // forkpty() can return just before the child completes setsid(). Capture its
  // immutable process generation now, then prove the session boundary at use.
  // A one-shot command may already be reaped; it has no session left to own.
  if (!identity) return pty
  if (identity.parentId !== process.pid) {
    throw new Error(`cannot prove ownership of PTY session ${String(pty.pid)}`)
  }
  ownedLinuxPtySessions.set(pty, identity)
  return pty
}

/**
 * Kill a spawned CLI and everything it started.
 *
 * On Windows a `spawnCli` child is a cmd.exe shim, so `child.kill()` removes
 * only the shim while the real agent binary keeps running — the reason
 * "stop" used to leave work happening invisibly in the background. taskkill
 * /T takes the whole tree down.
 */
export function killTree(child: KillableProcess): void {
  const groupId = ownedUnixProcessGroup(child)
  if (groupId !== undefined) {
    // The leader may have exited while its descendants still keep the group alive.
    signalProcessGroup(groupId, 'SIGTERM')
    return
  }
  // Loose != so test doubles without the fields count as still running.
  if (child.exitCode != null || child.signalCode != null) return
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    })
    if (!result.error && result.status === 0) return
  }
  child.kill()
}

export type TerminateTreeOptions = {
  gracePeriodMs?: number
  killWaitMs?: number
  pollIntervalMs?: number
}

/**
 * Stop every process in an owned PTY session before closing its leader.
 *
 * Interactive shells create a process group for each foreground/background
 * job, so signalling only the shell's group misses descendants. Keeping the
 * verified session leader alive during escalation prevents a reused numeric
 * session id from becoming authority to signal an unrelated process.
 */
export async function terminatePtySession(
  pty: PtyProcess,
  options: TerminateTreeOptions = {},
): Promise<void> {
  const captured = ownedLinuxPtySessions.get(pty)
  if (!captured) {
    pty.kill()
    return
  }
  const owner = await waitForEstablishedPtySession(captured)

  const signalled = new Set<string>()
  const members = signalNewPtySessionMembers(owner, 'SIGTERM', signalled)
  if (members.length === 0) {
    pty.kill()
    return
  }
  return finishPtySessionTermination(pty, owner, signalled, options)
}

/** Gracefully stop an owned tree, then bound shutdown with SIGKILL on Unix. */
export async function terminateTree(
  child: KillableProcess,
  options: TerminateTreeOptions = {},
): Promise<void> {
  const groupId = ownedUnixProcessGroup(child)
  if (groupId === undefined) {
    killTree(child)
    return
  }

  const gracePeriodMs = options.gracePeriodMs ?? 1_500
  const killWaitMs = options.killWaitMs ?? 1_500
  const pollIntervalMs = options.pollIntervalMs ?? 50
  signalProcessGroup(groupId, 'SIGTERM')
  if (await waitForProcessGroupExit(groupId, gracePeriodMs, pollIntervalMs)) return
  signalProcessGroup(groupId, 'SIGKILL')
  if (!(await waitForProcessGroupExit(groupId, killWaitMs, pollIntervalMs))) {
    throw new Error(`process group ${groupId} survived SIGKILL`)
  }
}

async function finishPtySessionTermination(
  pty: PtyProcess,
  owner: LinuxProcessIdentity,
  signalled: Set<string>,
  options: TerminateTreeOptions,
): Promise<void> {
  const gracePeriodMs = options.gracePeriodMs ?? 1_500
  const killWaitMs = options.killWaitMs ?? 1_500
  const pollIntervalMs = options.pollIntervalMs ?? 50
  if (
    await waitForPtySessionMembers(owner, gracePeriodMs, pollIntervalMs, (identity) =>
      signalNewLinuxProcess(identity, 'SIGTERM', signalled),
    )
  ) {
    pty.kill()
    return
  }

  const killed = new Set<string>()
  if (
    !(await waitForPtySessionMembers(owner, killWaitMs, pollIntervalMs, (identity) =>
      signalNewLinuxProcess(identity, 'SIGKILL', killed),
    ))
  ) {
    throw new Error(`PTY session ${owner.sessionId} survived SIGKILL`)
  }
  pty.kill()
}

async function waitForEstablishedPtySession(
  captured: LinuxProcessIdentity,
): Promise<LinuxProcessIdentity> {
  const startedAt = Date.now()
  do {
    const current = readLinuxProcessIdentity(captured.pid)
    if (
      !current ||
      !sameLinuxProcessInstance(current, captured) ||
      current.parentId !== captured.parentId
    ) {
      throw new Error(`cannot prove ownership of PTY session ${captured.pid}`)
    }
    if (current.groupId === current.pid && current.sessionId === current.pid) return current
    await new Promise((resolve) => setTimeout(resolve, PTY_SESSION_SETUP_POLL_MS))
  } while (Date.now() - startedAt < PTY_SESSION_SETUP_TIMEOUT_MS)
  throw new Error(`PTY session ${captured.pid} was not established`)
}

async function waitForPtySessionMembers(
  owner: LinuxProcessIdentity,
  timeoutMs: number,
  pollIntervalMs: number,
  onMember?: (identity: LinuxProcessIdentity) => void,
): Promise<boolean> {
  const startedAt = Date.now()
  do {
    const members = ownedPtySessionMembers(owner)
    if (members.length === 0) return true
    for (const identity of members) onMember?.(identity)
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  } while (Date.now() - startedAt < timeoutMs)
  return ownedPtySessionMembers(owner).length === 0
}

function signalNewPtySessionMembers(
  owner: LinuxProcessIdentity,
  signal: NodeJS.Signals,
  signalled: Set<string>,
): LinuxProcessIdentity[] {
  const members = ownedPtySessionMembers(owner)
  for (const identity of members) signalNewLinuxProcess(identity, signal, signalled)
  return members
}

function signalNewLinuxProcess(
  identity: LinuxProcessIdentity,
  signal: NodeJS.Signals,
  signalled: Set<string>,
): void {
  const key = `${identity.pid}:${identity.startTime}`
  if (signalled.has(key)) return
  signalLinuxProcess(identity, signal)
  signalled.add(key)
}

function signalLinuxProcess(identity: LinuxProcessIdentity, signal: NodeJS.Signals): void {
  const current = readLinuxProcessIdentity(identity.pid)
  if (!current) return
  if (!sameLinuxProcessGeneration(current, identity)) {
    throw new Error(`process identity changed before ${signal}: ${identity.pid}`)
  }
  try {
    process.kill(identity.pid, signal)
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error
  }
}

function ownedPtySessionMembers(owner: LinuxProcessIdentity): LinuxProcessIdentity[] {
  const leader = readLinuxProcessIdentity(owner.pid)
  if (!leader || !sameLinuxProcessGeneration(leader, owner) || leader.parentId !== owner.parentId) {
    throw new Error(`PTY session leader changed before cleanup completed: ${owner.pid}`)
  }

  const members: LinuxProcessIdentity[] = []
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const identity = readLinuxProcessIdentity(Number(entry.name))
    if (
      identity &&
      identity.pid !== owner.pid &&
      identity.sessionId === owner.sessionId &&
      identity.uid === owner.uid
    ) {
      members.push(identity)
    }
  }
  return members
}

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | undefined {
  if (!validProcessGroupId(pid)) return undefined
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = raw.lastIndexOf(')')
    if (commandEnd < 0) return undefined
    const fields = raw.slice(commandEnd + 2).split(' ')
    const parentId = Number(fields[1])
    const groupId = Number(fields[2])
    const sessionId = Number(fields[3])
    const startTime = fields[19]
    if (
      !validProcessGroupId(parentId) ||
      !validProcessGroupId(groupId) ||
      !validProcessGroupId(sessionId) ||
      startTime === undefined
    ) {
      return undefined
    }
    return {
      pid,
      parentId,
      groupId,
      sessionId,
      startTime,
      uid: statSync(`/proc/${pid}`).uid,
    }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ESRCH') return undefined
    throw error
  }
}

// Descendants can be reparented during teardown. The leader's parent is checked
// separately because it is the ownership anchor; member identity must survive
// a legitimate PPID change without widening authority beyond its SID and UID.
function sameLinuxProcessGeneration(
  left: LinuxProcessIdentity,
  right: LinuxProcessIdentity,
): boolean {
  return (
    sameLinuxProcessInstance(left, right) &&
    left.groupId === right.groupId &&
    left.sessionId === right.sessionId
  )
}

function sameLinuxProcessInstance(
  left: LinuxProcessIdentity,
  right: LinuxProcessIdentity,
): boolean {
  return left.pid === right.pid && left.startTime === right.startTime && left.uid === right.uid
}

function ownedUnixProcessGroup(child: KillableProcess): number | undefined {
  return process.platform !== 'win32' &&
    validProcessGroupId(child.pid) &&
    ownedUnixProcessGroups.has(child)
    ? child.pid
    : undefined
}

function validProcessGroupId(pid: number | undefined): pid is number {
  return Number.isInteger(pid) && (pid ?? 0) > 0
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const startedAt = Date.now()
  do {
    if (!processGroupAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  } while (Date.now() - startedAt < timeoutMs)
  return false
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
