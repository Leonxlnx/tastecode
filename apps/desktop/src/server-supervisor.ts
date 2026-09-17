import { spawn, type ChildProcess } from 'node:child_process'
import { killTree, type KillableProcess } from '@harness/proc/kill'

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

/** After this many failures in a row the server is not coming back on its own. */
export const MAX_CONSECUTIVE_FAILURES = 8

type SupervisorCallbacks = {
  onLog: (line: string) => void
  /** Called once when the supervisor gives up, for a user-facing surface. */
  onGaveUp?: (() => void) | undefined
  /**
   * Reports the pid of each successful launch so the caller can record server
   * ownership — a hard crash leaves no other way to attribute the orphan later.
   */
  onSpawned?: ((pid: number | undefined) => void) | undefined
  /**
   * Consulted once, when a run dies before the healthy threshold — the
   * signature of a resource conflict (port or data lease already held), which
   * restarting cannot fix on its own. 'stop' ends supervision quietly (the
   * caller adopted or reported the conflict); 'restart' resumes the normal
   * backoff path.
   */
  onEarlyExit?: (() => Promise<'restart' | 'stop'> | 'restart' | 'stop') | undefined
}

type CommandSupervisorOptions = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string | undefined
  spawnFn?: typeof spawn
}

// KillableProcess (pid, exitCode, signalCode, kill) lets stop() tear down the
// whole process tree, not just the direct child.
export type SupervisedServerProcess = KillableProcess & {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
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
    // Read lazily: pid only exists after spawn, exitCode/signalCode after exit.
    get pid() {
      return child.pid
    },
    get exitCode() {
      return child.exitCode
    },
    get signalCode() {
      return child.signalCode
    },
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    onError: (listener) => child.on('error', listener),
    onExit: (listener) => child.on('exit', listener),
  }
}

export class ServerSupervisor {
  readonly #options: SupervisorOptions
  #child: SupervisedServerProcess | undefined
  #stopped = false
  #failures = 0
  #startedAt = 0
  #restartTimer: NodeJS.Timeout | undefined
  #earlyExitChecked = false

  constructor(options: SupervisorOptions) {
    this.#options = options
  }

  start(): void {
    if (this.#stopped || this.#child) return
    this.#startedAt = Date.now()
    let child: SupervisedServerProcess
    try {
      child =
        'launch' in this.#options
          ? this.#options.launch()
          : supervisedChildProcess(
              (this.#options.spawnFn ?? spawn)(this.#options.command, this.#options.args, {
                env: this.#options.env,
                ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
              }),
            )
    } catch (error) {
      // utilityProcess.fork throws synchronously when the entry cannot launch.
      // Inside the restart timer that throw would escape as an
      // uncaughtException and kill the whole app, so it counts as a failed run.
      this.#options.onLog(`server failed to launch: ${String(error)}`)
      this.#scheduleRestart()
      return
    }
    this.#child = child
    this.#options.onSpawned?.(child.pid)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    // A chunk can split a line anywhere, so each stream keeps its partial tail
    // — otherwise markers like "[server] listening" never match. A stream that
    // ends mid-line still forwards the remainder.
    const forwardLines = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return
      let pending = ''
      stream.on('data', (chunk: string) => {
        const lines = (pending + chunk).split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) this.#options.onLog(line)
      })
      stream.on('end', () => {
        if (pending.trim()) this.#options.onLog(pending)
        pending = ''
      })
    }
    forwardLines(child.stdout)
    forwardLines(child.stderr)
    child.onError((error) => {
      this.#options.onLog(`server failed to start: ${String(error)}`)
      this.#onExit(child)
    })
    child.onExit((code, signal) => {
      this.#options.onLog(`server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
      this.#onExit(child)
    })
  }

  stop(): void {
    this.#stopped = true
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
    const child = this.#child
    this.#child = undefined
    if (!child) return
    // kill() alone stops only the direct child — on Windows that would orphan
    // the provider processes the server spawned. killTree ends the tree there
    // (taskkill /T) and escalates TERM→KILL elsewhere.
    void killTree(child).catch((error: unknown) => {
      this.#options.onLog(`server did not stop cleanly: ${String(error)}`)
    })
  }

  #onExit(child: SupervisedServerProcess): void {
    if (this.#child !== child) return
    this.#child = undefined
    if (this.#stopped) return
    // The first early death is where a stale-server conflict shows up (the
    // port or the data lease is still held). Consult the owner once before
    // falling back to blind backoff — later deaths stay on the normal path.
    if (
      !this.#earlyExitChecked &&
      this.#options.onEarlyExit &&
      Date.now() - this.#startedAt < HEALTHY_RUN_MS
    ) {
      this.#earlyExitChecked = true
      void this.#resolveEarlyExit()
      return
    }
    this.#scheduleRestart()
  }

  async #resolveEarlyExit(): Promise<void> {
    const onEarlyExit = this.#options.onEarlyExit
    let decision: 'restart' | 'stop' = 'restart'
    if (onEarlyExit) {
      try {
        decision = await onEarlyExit()
      } catch (error) {
        this.#options.onLog(`early-exit check failed: ${String(error)}`)
      }
    }
    if (this.#stopped || this.#child) return
    if (decision === 'stop') {
      this.#stopped = true
      return
    }
    this.#scheduleRestart()
  }

  #scheduleRestart(): void {
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
