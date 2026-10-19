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
  return stopTree(child, true)
}

function stopTree(child: KillableProcess, retry: boolean): Promise<void> {
  const existing = stopping.get(child)
  if (existing) return existing
  const done = terminate(child, retry).catch((error: unknown) => {
    stopping.delete(child)
    throw error
  })
  // Some lifecycle hooks initiate cleanup without an await; callers that do
  // await still receive the failure and can retry with ownership preserved.
  void done.catch(() => undefined)
  stopping.set(child, done)
  return done
}

async function terminate(child: KillableProcess, retry: boolean): Promise<void> {
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
    // taskkill takes about half a second. Run it asynchronously: a synchronous
    // call would stop the server's only event loop, and every stream with it.
    // taskkill can finish before Node observes the child's exit event.
    const exited = () => child.exitCode != null || child.signalCode != null
    const outcome = await stopWindowsTree(
      child.pid,
      () => {
        // Every late run failed, so no taskkill is walking the tree any more.
        if (!exited()) child.kill()
      },
      retry,
    )
    // taskkill still owns this stop. Killing the shim now would orphan the CLI
    // it started, so the stop is left to the run that is still going.
    if (outcome === 'running') return
    if (outcome === 'stopped' && (await waitUntil(exited, 500))) return
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

/**
 * One `taskkill /T /F` run. `exit` resolves with its exit code, or null when it
 * could not start; `release` lets this process exit while the run continues.
 */
export type TaskkillRun = { exit: Promise<number | null>; release(): void }
export type TaskkillLauncher = (pid: number) => TaskkillRun

// taskkill usually needs half a second, but it has taken 30 s on a loaded PC.
// A second run starts when the first is slow or fails, and the caller stops
// waiting after the whole budget.
const TASKKILL_RETRY_AFTER_MS = 5_000
const TASKKILL_BUDGET_MS = 15_000

const launchTaskkillProcess: TaskkillLauncher = (pid) => {
  let killer: ChildProcess
  try {
    killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch {
    return { exit: Promise.resolve(null), release: () => undefined }
  }
  const exit = new Promise<number | null>((resolve) => {
    killer.once('error', () => resolve(null))
    killer.once('exit', (code) => resolve(code))
  })
  return { exit, release: () => killer.unref() }
}

let launchTaskkill = launchTaskkillProcess

/** Replace the taskkill launcher in tests; no argument restores the real one. */
export function setTaskkillLauncherForTests(launcher?: TaskkillLauncher): void {
  launchTaskkill = launcher ?? launchTaskkillProcess
}

/**
 * Stop a Windows process tree with `taskkill /T /F`, never by killing taskkill.
 *
 * Every npm CLI starts as cmd.exe running a .cmd shim, so `pid` is the shim and
 * the real CLI is its child. Windows does not stop children with their parent,
 * and once the shim is gone `taskkill /T` can no longer find the tree. Killing
 * a slow taskkill and then the shim is how dozens of `opencode serve` processes
 * outlived the app. A slow run keeps going while a second one is tried. After
 * the budget the runs are left to finish on their own, and `onLateFailure`
 * runs if every one of them then fails. Without `retry` there is only the
 * first run.
 *
 * `stopped`: a run exited cleanly. `failed`: every run exited with an error and
 * none is still running. `running`: the budget ran out with taskkill still busy.
 */
async function stopWindowsTree(
  pid: number,
  onLateFailure: () => void,
  retry: boolean,
): Promise<'stopped' | 'failed' | 'running'> {
  const startedAt = Date.now()
  const runs = [launchTaskkill(pid)]
  if (retry) {
    if ((await taskkillOutcome(runs, TASKKILL_RETRY_AFTER_MS)) === 'stopped') return 'stopped'
    runs.push(launchTaskkill(pid))
  }
  const outcome = await taskkillOutcome(runs, TASKKILL_BUDGET_MS - (Date.now() - startedAt))
  if (outcome === 'running') {
    for (const run of runs) run.release()
    void taskkillOutcome(runs).then((late) => {
      if (late === 'failed') onLateFailure()
    })
  }
  return outcome
}

/** Wait, up to `timeoutMs` when given, for any run to exit cleanly or for all to fail. */
function taskkillOutcome(
  runs: TaskkillRun[],
  timeoutMs?: number,
): Promise<'stopped' | 'failed' | 'running'> {
  return new Promise((resolve) => {
    let failed = 0
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => resolve('running'), Math.max(0, timeoutMs))
    const settle = (outcome: 'stopped' | 'failed') => {
      clearTimeout(timer)
      resolve(outcome)
    }
    for (const run of runs) {
      void run.exit.then((code) => {
        if (code === 0) settle('stopped')
        else if (++failed === runs.length) settle('failed')
      })
    }
  })
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
  // One -o per column: BSD ps on macOS takes everything after the first `=`
  // as that column's header, so `pid=,pgid=,stat=` would print one column.
  const result = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], {
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
