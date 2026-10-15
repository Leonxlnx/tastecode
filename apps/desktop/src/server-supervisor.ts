import { spawn, type ChildProcess } from 'node:child_process'

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
export const SERVER_SHUTDOWN_TIMEOUT_MS = 3_000
const MAX_LOG_LINE = 64 * 1024

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
  requestShutdown?: () => void | Promise<void>
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
    kill: () => child.kill('SIGKILL'),
    requestShutdown: () =>
      new Promise<void>((resolve, reject) => {
        if (!child.connected) {
          reject(new Error('Server shutdown channel is closed'))
          return
        }
        child.send({ type: 'harness:shutdown' }, (error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
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
  #stopPromise: Promise<void> | undefined
  #gaveUp = false

  constructor(options: SupervisorOptions) {
    this.#options = options
  }

  /** True after restarts stopped and before a deliberate restart. */
  get gaveUp(): boolean {
    return this.#gaveUp
  }

  /** Starts again after giving up. Only a user action calls this, so it cannot loop. */
  restart(): boolean {
    if (this.#stopped || this.#child || !this.#gaveUp) return false
    this.#gaveUp = false
    this.#failures = 0
    this.start()
    return true
  }

  start(): void {
    if (this.#stopped || this.#child) return
    this.#startedAt = Date.now()
    const child =
      'launch' in this.#options
        ? this.#options.launch()
        : supervisedChildProcess(
            (this.#options.spawnFn ?? spawn)(this.#options.command, this.#options.args, {
              env: this.#options.env,
              ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
              windowsHide: true,
            }),
          )
    this.#child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    // Pipes split writes anywhere, so ready markers must be matched on whole lines.
    const forward = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return
      let pending = ''
      const emit = (line: string) => {
        if (line.trim()) this.#options.onLog(line)
      }
      stream.on('data', (chunk: string) => {
        const lines = (pending + chunk).split(/\r?\n/)
        pending = lines.pop() ?? ''
        // A runaway line without a newline must not grow without bound.
        if (pending.length > MAX_LOG_LINE) {
          emit(pending)
          pending = ''
        }
        for (const line of lines) emit(line)
      })
      stream.on('end', () => {
        emit(pending)
        pending = ''
      })
    }
    forward(child.stdout)
    forward(child.stderr)
    child.onError((error) => {
      this.#options.onLog(`server failed to start: ${String(error)}`)
      this.#onExit(child)
    })
    child.onExit((code, signal) => {
      this.#options.onLog(`server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
      this.#onExit(child)
    })
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopped = true
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = undefined
    const child = this.#child
    if (!child) return (this.#stopPromise = Promise.resolve())
    let resolve!: () => void
    this.#stopPromise = new Promise<void>((done) => {
      resolve = done
    })
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (this.#child === child) this.#child = undefined
      resolve()
    }
    const forceStop = () => {
      if (finished) return
      try {
        child.kill()
      } catch (error) {
        this.#options.onLog(`server could not be stopped: ${String(error)}`)
      } finally {
        finish()
      }
    }
    const timer = setTimeout(forceStop, SERVER_SHUTDOWN_TIMEOUT_MS)
    child.onExit(finish)
    if (child.requestShutdown) {
      void Promise.resolve()
        .then(() => child.requestShutdown!())
        .catch(forceStop)
    } else forceStop()
    return this.#stopPromise
  }

  #onExit(child: SupervisedServerProcess): void {
    if (this.#child !== child) return
    this.#child = undefined
    if (this.#stopped) return
    const healthy = Date.now() - this.#startedAt >= HEALTHY_RUN_MS
    this.#failures = healthy ? 1 : this.#failures + 1
    if (this.#failures > MAX_CONSECUTIVE_FAILURES) {
      this.#options.onLog('server keeps dying; giving up on restarts')
      this.#gaveUp = true
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
