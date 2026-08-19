import { spawnSync, type ChildProcess } from 'node:child_process'

export type KillableProcess = Pick<ChildProcess, 'exitCode' | 'signalCode' | 'pid' | 'kill'>

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
