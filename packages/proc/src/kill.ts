import {
  spawn,
  spawnSync,
  ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process'

export type KillableProcess = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'pid' | 'kill'>

const groups = new WeakMap<KillableProcess, number>()
const stopping = new WeakMap<KillableProcess, Promise<void>>()

/** Native executable spawn with a private process group on POSIX. */
export function spawnOwned(
  command: string,
  args: readonly string[],
  options?: SpawnOptions & { stdio?: 'pipe' | ['pipe', 'pipe', 'pipe'] },
): ChildProcessWithoutNullStreams
export function spawnOwned(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess
export function spawnOwned(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' })
  if (process.platform !== 'win32' && child.pid) {
    const group = child.pid
    groups.set(child, group)
    // The leader can exit before a background command. Keep its descendants
    // inside the same owned lifetime, and retire the group before pid reuse.
    child.once('exit', () => {
      void killTree(child).catch(() => undefined)
    })
  }
  return child
}

/** Terminate only a tree we own, then wait for bounded TERM/KILL escalation. */
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
  if (child.exitCode != null || child.signalCode != null) return
  // A failed spawn has no process to signal. Its native handle may still
  // contain pid 0, which means the caller's own process group on POSIX.
  if (!child.pid && child.kill === ChildProcess.prototype.kill) return
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 1_500,
    })
    if (!result.error && result.status === 0) return
  }
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
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
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
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  return true
}
