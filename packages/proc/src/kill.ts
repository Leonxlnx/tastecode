import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'

export type KillableProcess = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'pid' | 'kill'>

export const OWNED_PROCESS_SHUTDOWN_MESSAGE = 'harness:shutdown'

const ownedUnixProcessGroups = new WeakMap<object, number>()
const ownedLinuxPtySessions = new WeakMap<object, Promise<LinuxPtySessionOwnership>>()
const PTY_SESSION_SETUP_TIMEOUT_MS = 250
const PTY_SESSION_SETUP_POLL_MS = 5

type PtyProcess = {
  pid: number
  kill(signal?: string): void
}

type LinuxProcessIdentity = {
  pid: number
  state: string
  parentId: number
  groupId: number
  sessionId: number
  startTime: string
  uid: number
}

type LinuxPtySessionOwnership =
  { kind: 'owned'; owner: LinuxProcessIdentity } | { kind: 'failed'; error: unknown }

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
  // Snapshot the group id now. The leader may exit after SIGTERM while
  // descendants keep the group alive; re-reading child.pid at escalate time
  // would lose the group (or follow a mutated pid onto an arbitrary group).
  if (platform !== 'win32' && validProcessGroupId(child.pid))
    ownedUnixProcessGroups.set(child, child.pid)
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
  ownedLinuxPtySessions.set(pty, establishLinuxPtySession(identity))
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
  const ownership = ownedLinuxPtySessions.get(pty)
  if (!ownership) {
    pty.kill()
    return
  }
  const session = await ownership
  if (session.kind === 'failed') throw session.error
  const owner = session.owner
  const leader = readLinuxProcessIdentity(owner.pid)
  if (!leader || leader.state === 'Z' || leader.state === 'X') {
    await terminateExitedPtySession(owner, options)
    return
  }
  if (!sameLinuxProcessGeneration(leader, owner) || leader.parentId !== owner.parentId) {
    throw new Error(`PTY session leader changed before cleanup completed: ${owner.pid}`)
  }
  signalLinuxProcess(owner, 'SIGSTOP')
  try {
    if (!(await waitForStoppedLinuxProcess(owner))) {
      await terminateExitedPtySession(owner, options)
      return
    }
    const signalled = new Set<string>()
    const members = signalNewPtySessionMembers(owner, 'SIGTERM', signalled)
    if (members.length > 0) {
      await finishPtySessionTermination(owner, signalled, options)
    }
    // The frozen shell cannot run a signal handler that creates a last child
    // after the final empty scan. SIGKILL also handles shells that ignore HUP.
    signalLinuxProcess(owner, 'SIGKILL')
  } catch (error) {
    signalLinuxProcess(owner, 'SIGCONT')
    throw error
  }
}

/** Clean descendants after node-pty has already reported the leader's exit. */
export async function cleanupExitedPtySession(
  pty: PtyProcess,
  options: TerminateTreeOptions = {},
): Promise<void> {
  const ownership = ownedLinuxPtySessions.get(pty)
  if (!ownership) return
  const session = await ownership
  if (session.kind === 'failed') throw session.error
  await terminateExitedPtySession(session.owner, options)
}

async function terminateExitedPtySession(
  owner: LinuxProcessIdentity,
  options: TerminateTreeOptions,
): Promise<void> {
  const signalled = new Set<string>()
  const members = signalNewPtySessionMembers(owner, 'SIGTERM', signalled, linuxPtySessionMembers)
  if (members.length > 0) {
    await finishPtySessionTermination(owner, signalled, options, linuxPtySessionMembers)
  }
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
  // groupId is the snapshot from ownProcessTree, so SIGKILL below escalates
  // the same group even when the leader exits after SIGTERM. Signalling is
  // idempotent: an already-reaped group reports ESRCH and reads as exited.
  signalProcessGroup(groupId, 'SIGTERM')
  if (await waitForProcessGroupExit(groupId, gracePeriodMs, pollIntervalMs)) return
  signalProcessGroup(groupId, 'SIGKILL')
  if (!(await waitForProcessGroupExit(groupId, killWaitMs, pollIntervalMs))) {
    throw new Error(`process group ${groupId} survived SIGKILL`)
  }
}

async function finishPtySessionTermination(
  owner: LinuxProcessIdentity,
  signalled: Set<string>,
  options: TerminateTreeOptions,
  readMembers: (owner: LinuxProcessIdentity) => LinuxProcessIdentity[] = ownedPtySessionMembers,
): Promise<void> {
  const gracePeriodMs = options.gracePeriodMs ?? 1_500
  const killWaitMs = options.killWaitMs ?? 1_500
  const pollIntervalMs = options.pollIntervalMs ?? 50
  if (
    await waitForPtySessionMembers(
      owner,
      gracePeriodMs,
      pollIntervalMs,
      (identity) => signalNewLinuxProcess(identity, 'SIGTERM', signalled),
      readMembers,
    )
  ) {
    return
  }

  const killed = new Set<string>()
  if (
    !(await waitForPtySessionMembers(
      owner,
      killWaitMs,
      pollIntervalMs,
      (identity) => signalNewLinuxProcess(identity, 'SIGKILL', killed),
      readMembers,
    ))
  ) {
    throw new Error(`PTY session ${owner.sessionId} survived SIGKILL`)
  }
}

async function waitForStoppedLinuxProcess(owner: LinuxProcessIdentity): Promise<boolean> {
  const startedAt = Date.now()
  do {
    const current = readLinuxProcessIdentity(owner.pid)
    if (!current) return false
    if (!sameLinuxProcessGeneration(current, owner)) {
      throw new Error(`PTY session leader changed while stopping: ${owner.pid}`)
    }
    if (current.state === 'Z' || current.state === 'X') return false
    if (current.state === 'T' || current.state === 't') return true
    await new Promise((resolve) => setTimeout(resolve, PTY_SESSION_SETUP_POLL_MS))
  } while (Date.now() - startedAt < PTY_SESSION_SETUP_TIMEOUT_MS)
  throw new Error(`PTY session leader ${owner.pid} did not stop`)
}

async function waitForEstablishedPtySession(
  captured: LinuxProcessIdentity,
): Promise<LinuxProcessIdentity> {
  const startedAt = Date.now()
  do {
    const current = readLinuxProcessIdentity(captured.pid)
    // forkpty creates a session whose id is the captured child pid. Once that
    // generation disappears, any surviving member keeps the kernel SID alive
    // and prevents that numeric id from being reused until cleanup finishes.
    if (!current) return expectedLinuxPtySession(captured)
    if (!sameLinuxProcessInstance(current, captured) || current.parentId !== captured.parentId) {
      throw new Error(`cannot prove ownership of PTY session ${captured.pid}`)
    }
    if (current.groupId === current.pid && current.sessionId === current.pid) return current
    if (current.state === 'Z' || current.state === 'X') {
      return expectedLinuxPtySession(captured)
    }
    await new Promise((resolve) => setTimeout(resolve, PTY_SESSION_SETUP_POLL_MS))
  } while (Date.now() - startedAt < PTY_SESSION_SETUP_TIMEOUT_MS)
  throw new Error(`PTY session ${captured.pid} was not established`)
}

async function establishLinuxPtySession(
  captured: LinuxProcessIdentity,
): Promise<LinuxPtySessionOwnership> {
  try {
    const owner = await waitForEstablishedPtySession(captured)
    return { kind: 'owned', owner }
  } catch (error) {
    return { kind: 'failed', error }
  }
}

function expectedLinuxPtySession(captured: LinuxProcessIdentity): LinuxProcessIdentity {
  return { ...captured, groupId: captured.pid, sessionId: captured.pid }
}

async function waitForPtySessionMembers(
  owner: LinuxProcessIdentity,
  timeoutMs: number,
  pollIntervalMs: number,
  onMember?: (identity: LinuxProcessIdentity) => void,
  readMembers: (owner: LinuxProcessIdentity) => LinuxProcessIdentity[] = ownedPtySessionMembers,
): Promise<boolean> {
  const startedAt = Date.now()
  do {
    const members = readMembers(owner)
    if (members.length === 0) return true
    for (const identity of members) onMember?.(identity)
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  } while (Date.now() - startedAt < timeoutMs)
  return readMembers(owner).length === 0
}

function signalNewPtySessionMembers(
  owner: LinuxProcessIdentity,
  signal: NodeJS.Signals,
  signalled: Set<string>,
  readMembers: (owner: LinuxProcessIdentity) => LinuxProcessIdentity[] = ownedPtySessionMembers,
): LinuxProcessIdentity[] {
  const members = readMembers(owner)
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

  return linuxPtySessionMembers(owner)
}

function linuxPtySessionMembers(owner: LinuxProcessIdentity): LinuxProcessIdentity[] {
  const members: LinuxProcessIdentity[] = []
  // Dirent creation may lstat a PID after it exits; the stat reader below
  // already handles that normal /proc race without losing the whole scan.
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const identity = readOwnedLinuxProcessIdentity(Number(entry), owner.uid)
    if (
      identity &&
      identity.pid !== owner.pid &&
      identity.state !== 'Z' &&
      identity.state !== 'X' &&
      identity.sessionId === owner.sessionId &&
      identity.uid === owner.uid
    ) {
      members.push(identity)
    }
  }
  return members
}

function readOwnedLinuxProcessIdentity(
  pid: number,
  ownerUid: number,
): LinuxProcessIdentity | undefined {
  let uid
  try {
    uid = statSync(`/proc/${pid}`).uid
  } catch (error) {
    const code = errorCode(error)
    // A vanished or inaccessible directory cannot be one of our same-UID
    // descendants on supported Linux /proc policies. Filter it before reading
    // stat so an unrelated protected process cannot abort the owned scan.
    if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM') {
      return undefined
    }
    throw error
  }
  if (uid !== ownerUid) return undefined
  return readLinuxProcessIdentity(pid, uid)
}

function readLinuxProcessIdentity(
  pid: number,
  knownUid?: number,
): LinuxProcessIdentity | undefined {
  if (!validProcessGroupId(pid)) return undefined
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = raw.lastIndexOf(')')
    if (commandEnd < 0) return undefined
    const fields = raw.slice(commandEnd + 2).split(' ')
    const state = fields[0]
    const parentId = Number(fields[1])
    const groupId = Number(fields[2])
    const sessionId = Number(fields[3])
    const startTime = fields[19]
    if (
      state === undefined ||
      state.length !== 1 ||
      !validProcessGroupId(parentId) ||
      !validProcessGroupId(groupId) ||
      !validProcessGroupId(sessionId) ||
      startTime === undefined
    ) {
      return undefined
    }
    return {
      pid,
      state,
      parentId,
      groupId,
      sessionId,
      startTime,
      uid: knownUid ?? statSync(`/proc/${pid}`).uid,
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
  // Owner-safe lookup: only a group TasteCode snapshotted in ownProcessTree
  // may receive a negative-PID signal. The stored id — not the live
  // child.pid — survives leader exit so SIGKILL escalates the same group that
  // received SIGTERM. Anything unowned falls through to the single-PID /
  // taskkill paths below and never sends a group signal.
  if (process.platform === 'win32') return undefined
  const groupId = ownedUnixProcessGroups.get(child)
  return groupId !== undefined && validProcessGroupId(groupId) ? groupId : undefined
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
