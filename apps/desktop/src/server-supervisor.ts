import { spawn, type ChildProcess } from 'node:child_process'
import { ownProcessTree, ownedProcessSpawnOptions, terminateTree } from '@harness/proc'

/**
 * The packaged app owns its core server. In development tools/scripts/dev.js
 * runs the server with a watcher and the shell must keep its hands off — that
 * is signalled by HARNESS_DEV_SERVER being set. Everywhere else, nothing would
 * start the server at all and every feature would sit behind a permanent
 * "Reconnecting…" — which is exactly how the first packaged build behaved.
 *
 * Supervision, not just spawning: a server that dies comes back with backoff,
 * and one that keeps dying stops being restarted so a broken install does not
 * burn CPU in a loop. The child is torn down with the app.
 */

/** Exponential backoff, capped: 0.5s, 1s, 2s, 4s, 8s, then 15s forever. */
export function restartDelayMs(consecutiveFailures: number): number {
  return Math.min(15_000, 500 * 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 5))
}

/** A run that survived this long counts as healthy and resets the backoff. */
const HEALTHY_RUN_MS = 30_000

/** How long stop() waits for the utility-process server to exit after kill. */
const UTILITY_STOP_TIMEOUT_MS = 5_000

/** After this many failures in a row the server is not coming back on its own. */
export const MAX_CONSECUTIVE_FAILURES = 8

type SupervisorCallbacks = {
  onLog: (line: string) => void
  /** Called once when the supervisor gives up, for a user-facing surface. */
  onGaveUp?: (() => void) | undefined
}

type CommandSupervisorOptions = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string | undefined
  spawnFn?: typeof spawn
}

export type SupervisedServerProcess = {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  kill: () => boolean
  onError: (listener: (error: unknown) => void) => void
  onExit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void
}

type ProcessSupervisorOptions = {
  launch: () => SupervisedServerProcess
}

export type SupervisorOptions = SupervisorCallbacks &
  (CommandSupervisorOptions | ProcessSupervisorOptions)

function supervisedChildProcess(child: ChildProcess): SupervisedServerProcess {
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    onError: (listener) => child.on('error', listener),
    onExit: (listener) => child.on('exit', listener),
  }
}

/**
 * Resolve when a launched server reports exit (or error), giving up after
 * timeoutMs so stop() never waits forever. Uses only the existing
 * SupervisedServerProcess subscriptions, so no interface change is needed.
 */
function waitForSupervisedExit(child: SupervisedServerProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    child.onExit(done)
    child.onError(done)
  })
}

export class ServerSupervisor {
  readonly #options: SupervisorOptions
  #child: SupervisedServerProcess | undefined
  // Raw spawned child for tree termination. The utility-process launcher has
  // no pid to own, so only the command path registers one here.
  #processChild: ChildProcess | undefined
  #stopped = false
  #failures = 0
  #startedAt = 0
  #restartTimer: NodeJS.Timeout | undefined

  constructor(options: SupervisorOptions) {
    this.#options = options
  }

  start(): void {
    if (this.#stopped || this.#child) return
    this.#startedAt = Date.now()
    const child =
      'launch' in this.#options
        ? this.#options.launch()
        : supervisedChildProcess(this.#spawnOwned())
    this.#child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    const forward = (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.#options.onLog(line)
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.onError((error) => {
      this.#options.onLog(`server failed to start: ${String(error)}`)
      this.#onExit(child)
    })
    child.onExit((code, signal) => {
      this.#options.onLog(`server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
      this.#onExit(child)
    })
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
    const child = this.#child
    const processChild = this.#processChild
    this.#child = undefined
    this.#processChild = undefined
    // An owned process group outlives a bare child kill: the whole tree gets
    // a bounded TERM-to-KILL shutdown so quit leaves nothing behind on Linux.
    if (processChild) await terminateTree(processChild)
    else if (child) {
      // The default Electron utility-process path has no pid to own, so there
      // is no tree to terminate. Kill it, then wait for its exit event so
      // before-quit does not relaunch the app while the server still holds
      // the socket. The wait is bounded so a hung server cannot block quit.
      child.kill()
      await waitForSupervisedExit(child, UTILITY_STOP_TIMEOUT_MS)
    }
  }

  #spawnOwned(): ChildProcess {
    if ('launch' in this.#options) throw new Error('Launcher processes own their own lifetime.')
    const raw = ownProcessTree(
      (this.#options.spawnFn ?? spawn)(this.#options.command, this.#options.args, {
        env: this.#options.env,
        ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...ownedProcessSpawnOptions(),
      }),
    )
    this.#processChild = raw
    return raw
  }

  #onExit(child: SupervisedServerProcess): void {
    if (this.#child !== child) return
    this.#child = undefined
    this.#processChild = undefined
    if (this.#stopped) return
    const healthy = Date.now() - this.#startedAt >= HEALTHY_RUN_MS
    this.#failures = healthy ? 1 : this.#failures + 1
    if (this.#failures > MAX_CONSECUTIVE_FAILURES) {
      this.#options.onLog('server keeps dying; giving up on restarts')
      this.#options.onGaveUp?.()
      return
    }
    const delay = restartDelayMs(this.#failures)
    this.#options.onLog(`restarting server in ${delay}ms (attempt ${this.#failures})`)
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined
      this.start()
    }, delay)
  }
}
