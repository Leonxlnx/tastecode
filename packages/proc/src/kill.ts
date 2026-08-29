import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'

export type KillableProcess = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'pid' | 'kill'>

const ownedUnixProcessGroups = new WeakSet<object>()

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
  if (platform !== 'win32' && child.pid !== undefined) ownedUnixProcessGroups.add(child)
  return child
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

/** Gracefully stop an owned tree, then bound shutdown with SIGKILL on Unix. */
export async function terminateTree(
  child: KillableProcess,
  options: TerminateTreeOptions = {},
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return
  if (
    process.platform === 'win32' ||
    child.pid === undefined ||
    !ownedUnixProcessGroups.has(child)
  ) {
    killTree(child)
    return
  }

  const gracePeriodMs = options.gracePeriodMs ?? 1_500
  const killWaitMs = options.killWaitMs ?? 1_500
  const pollIntervalMs = options.pollIntervalMs ?? 50
  signalProcessGroup(child.pid, 'SIGTERM')
  if (await waitForProcessGroupExit(child.pid, gracePeriodMs, pollIntervalMs)) return
  signalProcessGroup(child.pid, 'SIGKILL')
  await waitForProcessGroupExit(child.pid, killWaitMs, pollIntervalMs)
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
