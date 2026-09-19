import {
  spawn,
  spawnSync,
  ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'

/**
 * Owned teardown for spawned process trees and Linux PTY sessions.
 *
 * Two mechanisms share one contract — a tree we spawned dies together:
 * - {@link spawnOwned} gives each POSIX child its own process group and
 *   {@link killTree} escalates the group through SIGTERM → SIGKILL; on
 *   Windows the exit hook and killTree run `taskkill /T` on the spawned pid,
 *   which also collects grandchildren a `.cmd` shim orphaned by exiting early.
 * - {@link ownPtySession} + {@link terminatePtySession} sweep a Linux PTY's
 *   kernel session by /proc scan while the verified leader is held stopped.
 *
 * Neither mechanism reaches processes that leave the owned boundary: a
 * grandchild that calls setsid() (daemonizes) drops out of its group or
 * session and survives, and members running under a different uid
 * (sudo/setuid) are never signalled. Off Linux there is no session sweep —
 * PTY teardown is leader-only, so descendants can outlive a closed terminal.
 */

export type KillableProcess = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'pid' | 'kill'>

// Caller-facing spawn options: `detached` is not offerable because the
// platform forces it (POSIX children always get a private group, Windows
// never does); `windowsHide` stays optional because it defaults to true.
type OwnedPipeSpawnOptions = Omit<SpawnOptions, 'cwd' | 'stdio' | 'detached' | 'windowsHide'> & {
  cwd?: string
  stdio: ['pipe', 'pipe', 'pipe']
  windowsHide?: boolean
}
// What an injected spawner always receives: spawnOwned fixes windowsHide and
// detached itself rather than trusting whatever a caller passed.
type ProcessSpawnerOptions = Omit<OwnedPipeSpawnOptions, 'windowsHide'> & {
  windowsHide: boolean
  detached: boolean
}
type ProcessSpawner = (
  command: string,
  args: string[],
  options: ProcessSpawnerOptions,
) => ChildProcessWithoutNullStreams

const groups = new WeakMap<KillableProcess, number>()
const stopping = new WeakMap<KillableProcess, Promise<void>>()
const ownedLinuxPtySessions = new WeakMap<object, Promise<LinuxPtySessionOwnership>>()
const PTY_SESSION_SETUP_TIMEOUT_MS = 250
const PTY_SESSION_SETUP_POLL_MS = 5
const UNOWNED_PTY_KILL_GRACE_MS = 250

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
  | { kind: 'owned'; owner: LinuxProcessIdentity }
  // The captured generation changed: nothing derived from it may be
  // signalled, so this failure must keep throwing instead of recovering.
  | { kind: 'unproven'; error: unknown }
  // setsid() had not completed by the setup deadline. The captured identity
  // is kept so a later teardown can still prove the session if the leader
  // finished establishing in the meantime.
  | { kind: 'unestablished'; error: unknown; captured: LinuxProcessIdentity }

/** The captured leader identity can no longer be trusted for signalling. */
class PtySessionOwnershipLostError extends Error {
  override name = 'PtySessionOwnershipLostError'
}

/** A scanned /proc entry was replaced by a new generation before signalling. */
class StaleLinuxProcessError extends Error {
  override name = 'StaleLinuxProcessError'
}

/** Native executable spawn with a private process group on POSIX. */
export function spawnOwned(
  command: string,
  args: readonly string[],
  options: OwnedPipeSpawnOptions,
  spawnProcess: ProcessSpawner,
): ChildProcessWithoutNullStreams
export function spawnOwned(
  command: string,
  args: readonly string[],
  options?: Omit<SpawnOptions, 'detached'> & { stdio?: 'pipe' | ['pipe', 'pipe', 'pipe'] },
): ChildProcessWithoutNullStreams
export function spawnOwned(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptions, 'detached'>,
): ChildProcess
export function spawnOwned(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
  spawnProcess?: ProcessSpawner,
): ChildProcess {
  const detached = process.platform !== 'win32'
  let child: ChildProcess
  if (spawnProcess) {
    const { cwd, stdio: _stdio, ...rest } = options
    child = spawnProcess(command, [...args], {
      ...rest,
      ...(typeof cwd === 'string' ? { cwd } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: options.windowsHide ?? true,
      detached,
    })
  } else {
    child = spawn(command, args, { ...options, detached })
  }
  if (child.pid) {
    if (process.platform === 'win32') {
      child.once('exit', () => {
        // A .cmd shim can exit while grandchildren it started are still
        // running. taskkill /T takes down that remaining tree and fails
        // harmlessly when the pid is already gone.
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 1_500,
        })
      })
    } else {
      const group = child.pid
      groups.set(child, group)
      child.once('exit', () => {
        void killTree(child).catch(() => undefined)
      })
    }
  }
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
    throw new PtySessionOwnershipLostError(
      `cannot prove ownership of PTY session ${String(pty.pid)}`,
    )
  }
  ownedLinuxPtySessions.set(pty, establishLinuxPtySession(identity))
  return pty
}

/**
 * Terminate only a tree we own, then wait for bounded TERM/KILL escalation.
 *
 * The tree guarantee only covers children registered by {@link spawnOwned}:
 * POSIX signals the whole process group and Windows runs `taskkill /T`. An
 * unregistered child (or a test double) falls back to signalling the leader
 * alone on POSIX, so its descendants can outlive it — Windows still tree-kills
 * because taskkill walks the parent chain by pid.
 */
export function killTree(child: KillableProcess): Promise<void> {
  const existing = stopping.get(child)
  if (existing) return existing
  const done = terminate(child).catch((error: unknown) => {
    stopping.delete(child)
    throw error
  })
  // Some lifecycle hooks initiate cleanup without an await; callers that do
  // await still receive the failure and can retry with ownership preserved.
  void done.catch(() => undefined)
  stopping.set(child, done)
  return done
}

async function terminate(child: KillableProcess): Promise<void> {
  const group = groups.get(child)
  if (group) {
    // Keep the group after its leader exits: children can still be alive.
    // Never derive a group from an arbitrary pid supplied by a caller.
    if ((await signalGroup(group, 'SIGTERM')) && !(await waitForGroupExit(group, 500))) {
      await signalGroup(group, 'SIGKILL')
      if (!(await waitForGroupExit(group, 1_000)) && !onlyZombiesRemain(group)) {
        throw new Error('Owned process group did not stop after forced termination')
      }
    }
    groups.delete(child)
    return
  }
  // A failed spawn has no process to signal. Its native handle may still
  // contain pid 0, which means the caller's own process group on POSIX.
  if (!child.pid && child.kill === ChildProcess.prototype.kill) return
  if (process.platform === 'win32' && child.pid) {
    // taskkill /T still tears down a tree whose .cmd shim already exited, so
    // it runs before the exit check below; on a dead pid it fails harmlessly.
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 1_500,
    })
    if (!result.error && result.status === 0) return
  }
  if (child.exitCode != null || child.signalCode != null) return
  // Unregistered children and test doubles have no group ownership. Never
  // signal a guessed group, which could include the app or another task.
  child.kill()
  if (!child.pid) return
  if (await waitUntil(() => child.exitCode != null || child.signalCode != null, 500)) return
  child.kill('SIGKILL')
  if (!(await waitUntil(() => child.exitCode != null || child.signalCode != null, 1_000))) {
    throw new Error('Child process did not exit after forced termination')
  }
}

async function signalGroup(pid: number, signal: NodeJS.Signals): Promise<boolean> {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    // macOS can report EPERM while the last group member is disappearing.
    // A new ESRCH probe, not EPERM itself, must confirm that it is gone.
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      if (await waitForGroupExit(pid, 100)) return false
    }
    throw error
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let denied: Error | undefined
  while (true) {
    try {
      if (!groupExists(pid)) return true
      denied = undefined
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
      denied = error
    }
    if (Date.now() >= deadline) {
      if (denied) throw denied
      return false
    }
    await delay(25)
  }
}

function onlyZombiesRemain(group: number): boolean {
  // kill(pid, 0) includes zombies. They cannot run code or hold open files,
  // but only their parent/init can reap them. Verify that distinction instead
  // of declaring a surviving, possibly live group stopped after a timeout.
  const result = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], {
    encoding: 'utf8',
    timeout: 500,
    maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) return false
  const members = result.stdout.split('\n').flatMap((line) => {
    const row = /^\s*\d+\s+(\d+)\s+(\S+)/.exec(line)
    return row && Number(row[1]) === group ? [row[2]!] : []
  })
  return members.length > 0 ? members.every((state) => state.startsWith('Z')) : !groupExists(group)
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() >= deadline) return false
    await delay(25)
  }
  return true
}

/**
 * Poll sleep that does not hold the event loop open: an unawaited killTree
 * (e.g. the spawn exit hook) must not keep a closing process alive for the
 * full TERM/KILL escalation window.
 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    // EPERM still means the pid exists; the caller just cannot verify or
    // signal that generation, which is the same answer liveness-wise.
    if (errorCode(error) === 'EPERM') return true
    throw error
  }
}

/**
 * Leader-only teardown for a PTY that has no owned session to sweep.
 *
 * node-pty sends SIGHUP and a shell can ignore it, so a leader that survives
 * a short grace escalates to SIGKILL where POSIX signals are available —
 * otherwise close() would time out with the PTY still running. On Windows
 * node-pty already ends the process forcefully, so no escalation is needed.
 */
async function killUnownedPtyLeader(pty: PtyProcess): Promise<void> {
  pty.kill()
  if (process.platform === 'win32') return
  if (await waitUntil(() => !processAlive(pty.pid), UNOWNED_PTY_KILL_GRACE_MS)) return
  try {
    process.kill(pty.pid, 'SIGKILL')
  } catch (error) {
    const code = errorCode(error)
    // ESRCH: the leader left during the grace window. EPERM: the pid is not
    // ours to signal — there is nothing left this layer can do about it.
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
}

export type TerminatePtySessionOptions = {
  gracePeriodMs?: number
  killWaitMs?: number
  pollIntervalMs?: number
}

/**
 * Stop every process in a provably owned PTY session before closing its
 * leader.
 *
 * Interactive shells create a process group for each foreground/background
 * job, so signalling only the shell's group misses descendants. Keeping the
 * verified session leader alive during escalation prevents a reused numeric
 * session id from becoming authority to signal an unrelated process.
 *
 * The member sweep only exists on Linux, where {@link ownPtySession} proved
 * the kernel session from /proc. Everywhere else — and for a PTY whose
 * session stayed unprovable — teardown is leader-only ({@link
 * killUnownedPtyLeader}), so descendants can outlive the leader.
 */
export async function terminatePtySession(
  pty: PtyProcess,
  options: TerminatePtySessionOptions = {},
): Promise<void> {
  const ownership = ownedLinuxPtySessions.get(pty)
  if (!ownership) {
    await killUnownedPtyLeader(pty)
    return
  }
  const session = await ownership
  if (session.kind === 'unproven') throw session.error
  if (session.kind === 'unestablished') {
    // setsid() can still have completed after the setup deadline; prove it
    // from the immutable captured generation before deciding nothing exists
    // to sweep. A still-plain child gets leader-only teardown instead of a
    // cached failure that would rethrow forever.
    const owner = provenLinuxPtySessionOwner(session.captured)
    if (!owner) {
      ownedLinuxPtySessions.delete(pty)
      await killUnownedPtyLeader(pty)
      return
    }
    ownedLinuxPtySessions.set(
      pty,
      Promise.resolve<LinuxPtySessionOwnership>({ kind: 'owned', owner }),
    )
    return terminatePtySession(pty, options)
  }
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
    try {
      signalLinuxProcess(owner, 'SIGCONT')
    } catch {
      // Resuming the frozen leader is best-effort: it may already be gone,
      // and a SIGCONT failure must not mask the error that stopped it.
    }
    throw error
  }
}

/** Clean descendants after node-pty has already reported the leader's exit. */
export async function cleanupExitedPtySession(
  pty: PtyProcess,
  options: TerminatePtySessionOptions = {},
): Promise<void> {
  const ownership = ownedLinuxPtySessions.get(pty)
  if (!ownership) return
  const session = await ownership
  if (session.kind === 'unproven') throw session.error
  if (session.kind === 'unestablished') {
    // The leader may have finished setsid() after the setup deadline; only a
    // still-live leader can prove that now. A dead or never-established
    // leader leaves no members this layer can identify safely, so the cached
    // failure is dropped rather than rethrown forever.
    const owner = provenLinuxPtySessionOwner(session.captured)
    if (!owner) {
      ownedLinuxPtySessions.delete(pty)
      return
    }
    ownedLinuxPtySessions.set(
      pty,
      Promise.resolve<LinuxPtySessionOwnership>({ kind: 'owned', owner }),
    )
    await terminateExitedPtySession(owner, options)
    return
  }
  await terminateExitedPtySession(session.owner, options)
}

async function terminateExitedPtySession(
  owner: LinuxProcessIdentity,
  options: TerminatePtySessionOptions,
): Promise<void> {
  const signalled = new Set<string>()
  const members = signalNewPtySessionMembers(owner, 'SIGTERM', signalled, linuxPtySessionMembers)
  if (members.length > 0) {
    await finishPtySessionTermination(owner, signalled, options, linuxPtySessionMembers)
  }
}

async function finishPtySessionTermination(
  owner: LinuxProcessIdentity,
  signalled: Set<string>,
  options: TerminatePtySessionOptions,
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
    await delay(PTY_SESSION_SETUP_POLL_MS)
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
      throw new PtySessionOwnershipLostError(
        `cannot prove ownership of PTY session ${captured.pid}`,
      )
    }
    if (current.groupId === current.pid && current.sessionId === current.pid) return current
    if (current.state === 'Z' || current.state === 'X') {
      return expectedLinuxPtySession(captured)
    }
    await delay(PTY_SESSION_SETUP_POLL_MS)
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
    return error instanceof PtySessionOwnershipLostError
      ? { kind: 'unproven', error }
      : { kind: 'unestablished', error, captured }
  }
}

/**
 * Re-verify a leader whose setsid() had not finished by the setup deadline.
 * The captured generation is immutable, so the same pid/startTime/uid now
 * shown as its own session and group leader proves ownership late. Anything
 * else — a dead pid, a changed generation, a still-plain child — stays
 * unprovable.
 */
function provenLinuxPtySessionOwner(
  captured: LinuxProcessIdentity,
): LinuxProcessIdentity | undefined {
  try {
    const current = readLinuxProcessIdentity(captured.pid)
    if (
      !current ||
      !sameLinuxProcessInstance(current, captured) ||
      current.parentId !== captured.parentId ||
      current.sessionId !== current.pid ||
      current.groupId !== current.pid
    ) {
      return undefined
    }
    return current
  } catch {
    // A /proc read failure cannot prove anything either; degrade rather than
    // trade a cached failure for a fresh throw.
    return undefined
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
    await delay(pollIntervalMs)
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
  try {
    signalLinuxProcess(identity, signal)
  } catch (error) {
    // A member can exit and its pid can be reused between the /proc scan and
    // this signal. Skip the stale entry — the next rescan evaluates whatever
    // generation holds the pid now instead of aborting the whole sweep.
    if (error instanceof StaleLinuxProcessError) return
    throw error
  }
  signalled.add(key)
}

function signalLinuxProcess(identity: LinuxProcessIdentity, signal: NodeJS.Signals): void {
  const current = readLinuxProcessIdentity(identity.pid)
  if (!current) return
  if (!sameLinuxProcessGeneration(current, identity)) {
    throw new StaleLinuxProcessError(`process identity changed before ${signal}: ${identity.pid}`)
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

function validProcessGroupId(pid: number | undefined): pid is number {
  return Number.isInteger(pid) && (pid ?? 0) > 0
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
