import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import type { IPty, spawn as NodePtySpawn } from 'node-pty'
import { applyDesktopPath } from '@harness/proc/desktop-path'

const DEFAULT_CLOSE_TIMEOUT_MS = 10_000
// How long each step of a close may take. After SIGHUP the shell and its
// foreground job get `hangup` to finish a clean shutdown on their own; what is
// left then gets SIGTERM and `terminate`, then SIGKILL and `kill`. Server
// shutdown has to end inside the desktop's three-second force stop.
const CLOSE_STEPS = { hangup: 3_000, terminate: 3_000, kill: 1_000 }
const SHUTDOWN_STEPS = { hangup: 500, terminate: 600, kill: 300 }
const CLOSE_POLL_MS = 100
const DEFAULT_OUTPUT_BATCH_DELAY_MS = 4
const DEFAULT_OUTPUT_BATCH_SIZE = 64 * 1024
const RETAINED_OUTPUT_SIZE = 200_000
const RETAINED_EXIT_LIMIT = 64
const RETAINED_EXIT_TTL_MS = 60 * 60 * 1000
export type TerminalStatus = {
  status: 'running' | 'exited' | 'unknown'
  output: string
  outputOffset: number
  exitCode: number | null
}
type SpawnPty = typeof NodePtySpawn
/**
 * A POSIX shell's parent, own process group, its terminal's foreground group,
 * its session as `ps` prints it, and whether it leads that session.
 */
type ShellProcess = {
  parent: number
  group: number
  foreground: number
  session: string
  leader: boolean
}
type InspectShell = (pid: number) => ShellProcess | undefined
type CloseStep = keyof typeof CLOSE_STEPS
/** The foreground process group of a closed shell, and that shell's session. */
type Job = { group: number; session: string }
type GroupMember = { pid: number; session: string; zombie: boolean }
/** Reads and signals POSIX process groups; injectable so tests need no real job. */
type JobControl = {
  /** The group's members, or undefined when they cannot be read. */
  members(group: number): Promise<GroupMember[] | undefined>
  signal(group: number, signal: NodeJS.Signals): void
}

const execFileAsync = promisify(execFile)

const require = createRequire(import.meta.url)
let loadedSpawn: SpawnPty | undefined

/** Keep the native PTY binding out of idle startup; terminals are optional. */
const spawnPty: SpawnPty = (file, args, options) => {
  loadedSpawn ??= (require('node-pty') as { spawn: SpawnPty }).spawn
  return loadedSpawn(file, args, options)
}

type TerminalEntry = {
  key: string
  threadId: string
  process: IPty
  output: { dispose(): void }
  outputBuffer: TerminalOutputBuffer
  exited: Promise<void>
}

/** One short output clock for every active terminal owned by a manager. */
export class TerminalOutputScheduler {
  #pending = new Set<TerminalOutputBuffer>()
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly delayMs = DEFAULT_OUTPUT_BATCH_DELAY_MS) {}

  schedule(buffer: TerminalOutputBuffer): void {
    this.#pending.add(buffer)
    this.#timer ??= setTimeout(() => this.#flushWindow(), this.delayMs)
  }

  cancel(buffer: TerminalOutputBuffer): void {
    if (!this.#pending.delete(buffer) || this.#pending.size > 0) return
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #flushWindow(): void {
    this.#timer = undefined
    const pending = this.#pending
    this.#pending = new Set()
    for (const buffer of pending) buffer.flush()
  }
}

/**
 * Coalesce a burst of native PTY chunks into frame-sized renderer updates.
 * node-pty can emit thousands of tiny chunks during command output; forwarding
 * each one as its own JSON/WebSocket message costs far more than parsing the
 * same bytes in xterm. Interactive output still flushes within four
 * milliseconds, while sustained output flushes at 64 KiB to keep memory and
 * latency bounded.
 */
export class TerminalOutputBuffer {
  #firstChunk = ''
  #chunks: string[] | undefined
  #length = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #disposed = false

  constructor(
    private readonly emit: (data: string) => void,
    private readonly delayMs = DEFAULT_OUTPUT_BATCH_DELAY_MS,
    private readonly maximumSize = DEFAULT_OUTPUT_BATCH_SIZE,
    private readonly scheduler?: TerminalOutputScheduler,
  ) {}

  push(data: string): void {
    if (this.#disposed || data.length === 0) return
    const isFirstChunk = this.#length === 0
    if (isFirstChunk) this.#firstChunk = data
    else (this.#chunks ??= [this.#firstChunk]).push(data)
    this.#length += data.length
    if (this.#length >= this.maximumSize) {
      this.flush()
      return
    }
    if (isFirstChunk) {
      if (this.scheduler) this.scheduler.schedule(this)
      else this.#timer ??= setTimeout(() => this.flush(), this.delayMs)
    }
  }

  flush(): void {
    this.scheduler?.cancel(this)
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#length === 0 || this.#disposed) return
    const data = this.#chunks === undefined ? this.#firstChunk : this.#chunks.join('')
    this.#firstChunk = ''
    this.#chunks = undefined
    this.#length = 0
    this.emit(data)
  }

  dispose(): void {
    this.scheduler?.cancel(this)
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#firstChunk = ''
    this.#chunks = undefined
    this.#length = 0
    this.#disposed = true
  }
}

export class TerminalManager {
  #byId = new Map<string, TerminalEntry>()
  #byThread = new Map<string, string>()
  #closingById = new Map<string, Promise<void>>()
  #closingByThread = new Map<string, Set<Promise<void>>>()
  #closingThreads = new Map<string, Promise<void>>()
  #closingAll: Promise<void> | undefined
  #onOutput: (terminalId: string, data: string, outputOffset: number) => void
  #onExit: (terminalId: string, exitCode: number | null) => void
  #spawnPty: SpawnPty
  #inspectShell: InspectShell
  #jobControl: JobControl
  #closeTimeoutMs: number
  readonly #outputScheduler = new TerminalOutputScheduler()
  #status = new Map<string, TerminalStatus & { finishedAt?: number }>()

  constructor(
    handlers: {
      onOutput: (terminalId: string, data: string, outputOffset: number) => void
      onExit: (terminalId: string, exitCode: number | null) => void
    },
    options: {
      spawnPty?: SpawnPty
      inspectShell?: InspectShell
      jobControl?: JobControl
      closeTimeoutMs?: number
    } = {},
  ) {
    this.#onOutput = handlers.onOutput
    this.#onExit = handlers.onExit
    this.#spawnPty = options.spawnPty ?? spawnPty
    this.#inspectShell = options.inspectShell ?? inspectShell
    this.#jobControl = options.jobControl ?? processGroups
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
  }

  open(threadId: string, cwd: string, columns: number, rows: number, terminalKey?: string): string {
    const key = terminalKey ? JSON.stringify([threadId, terminalKey]) : threadId
    return this.#spawn(key, [], cwd, columns, rows, threadId)
  }

  /**
   * Run one command to completion in a terminal. Keyed like a thread terminal
   * so a second request for the same key reattaches to the run in progress
   * instead of starting the command twice. A real pty rather than a plain
   * child process, so an installer that asks a question can be handed to the
   * user instead of hanging invisibly.
   */
  run(key: string, command: string, cwd: string, columns: number, rows: number): string {
    const args =
      globalThis.process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
    return this.#spawn(key, args, cwd, columns, rows)
  }

  #spawn(
    key: string,
    args: string[],
    cwd: string,
    columns: number,
    rows: number,
    threadId = key,
  ): string {
    if (this.#closingAll) throw new Error('terminal manager is closing')
    if (this.#closingThreads.has(threadId)) throw new Error(`terminal is closing: ${key}`)

    const currentId = this.#byThread.get(key)
    if (currentId) {
      this.resize(currentId, columns, rows)
      return currentId
    }
    // A shell started in a missing folder prints a chdir error and exits at
    // once, which closes its pane before anyone can read why.
    if (!isFolder(cwd)) throw new Error('The folder for this terminal no longer exists.')

    const terminalId = randomUUID()
    this.#pruneStatuses()
    const process = this.#spawnPty(platformShell(), args, {
      name: 'xterm-256color',
      cols: columns,
      rows,
      cwd,
      env: terminalEnvironment(),
    })
    const status: TerminalStatus = {
      status: 'running',
      output: '',
      outputOffset: 0,
      exitCode: null,
    }
    this.#status.set(terminalId, status)
    const outputBuffer = new TerminalOutputBuffer(
      (data) => {
        const offset = status.outputOffset + status.output.length
        const next = status.output + data
        const removed = Math.max(0, next.length - RETAINED_OUTPUT_SIZE)
        status.outputOffset += removed
        status.output = next.slice(removed)
        this.#onOutput(terminalId, data, offset)
      },
      DEFAULT_OUTPUT_BATCH_DELAY_MS,
      DEFAULT_OUTPUT_BATCH_SIZE,
      this.#outputScheduler,
    )
    const output = process.onData((data) => outputBuffer.push(data))
    let resolveExited: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve
    })
    const entry = { key, threadId, process, output, outputBuffer, exited }
    this.#byId.set(terminalId, entry)
    this.#byThread.set(key, terminalId)

    process.onExit(({ exitCode }) => {
      // Preserve the last prompt or command output before publishing the exit.
      // Explicit close disposes the buffer first because that pane is gone.
      outputBuffer.flush()
      output.dispose()
      if (this.#byId.get(terminalId) === entry) {
        this.#byId.delete(terminalId)
        this.#byThread.delete(key)
      }
      resolveExited()
      status.status = 'exited'
      status.exitCode = Number.isInteger(exitCode) ? exitCode : null
      this.#status.set(terminalId, { ...status, finishedAt: Date.now() })
      this.#pruneStatuses()
      this.#onExit(terminalId, status.exitCode)
    })

    return terminalId
  }

  write(terminalId: string, data: string): void {
    this.#get(terminalId).process.write(data)
  }

  status(terminalId: string): TerminalStatus {
    // Include native output queued for the next short broadcast window.
    this.#byId.get(terminalId)?.outputBuffer.flush()
    this.#pruneStatuses()
    const status = this.#status.get(terminalId)
    return status
      ? {
          status: status.status,
          output: status.output,
          outputOffset: status.outputOffset,
          exitCode: status.exitCode,
        }
      : { status: 'unknown', output: '', outputOffset: 0, exitCode: null }
  }

  #pruneStatuses(): void {
    const now = Date.now()
    const finished: string[] = []
    for (const [id, entry] of this.#status) {
      if (entry.finishedAt === undefined) continue
      if (now - entry.finishedAt > RETAINED_EXIT_TTL_MS) this.#status.delete(id)
      else finished.push(id)
    }
    for (const id of finished.slice(0, Math.max(0, finished.length - RETAINED_EXIT_LIMIT))) {
      this.#status.delete(id)
    }
  }

  resize(terminalId: string, columns: number, rows: number): void {
    this.#get(terminalId).process.resize(columns, rows)
  }

  close(terminalId: string): Promise<void> {
    const alreadyClosing = this.#closingById.get(terminalId)
    if (alreadyClosing) return alreadyClosing

    const entry = this.#byId.get(terminalId)
    if (!entry) return Promise.resolve()
    // node-pty only sends SIGHUP, which a foreground job may ignore — a server
    // that treats it as "reload" outlives the pane. Read which job holds the
    // terminal now: once the shell exits, nothing records it.
    const shell = this.#ownedShell(entry.process.pid)
    const job =
      shell && shell.foreground > 1
        ? { group: shell.foreground, session: shell.session }
        : undefined
    // Kill first. If node-pty rejects the request synchronously, the terminal
    // remains attached and a later close can retry instead of losing it.
    entry.process.kill()
    this.#byId.delete(terminalId)
    // Only unmap the key if it still points at this terminal — closing a
    // stale id must not orphan a newer pty spawned under the same key.
    if (this.#byThread.get(entry.key) === terminalId) {
      this.#byThread.delete(entry.key)
    }
    // node-pty flushes buffered output after kill(); the client tore this
    // pane down, so those late chunks must not be broadcast for its id.
    entry.output.dispose()
    entry.outputBuffer.dispose()
    const exitedInTime = this.#boundedExit(terminalId, entry.exited)
    void exitedInTime.catch(() => undefined)
    const closing = this.#finishClose(entry, shell !== undefined, exitedInTime, job)
    this.#closingById.set(terminalId, closing)
    const threadClosings = this.#closingByThread.get(entry.threadId) ?? new Set<Promise<void>>()
    threadClosings.add(closing)
    this.#closingByThread.set(entry.threadId, threadClosings)
    // A timeout is a failed close, not evidence that the native process is
    // gone. Keep that generation tracked until its real exit arrives, and the
    // foreground job is stopped, so a retry or shutdown waits for both.
    void closing.catch(() => undefined)
    void Promise.allSettled([entry.exited, closing]).then(() =>
      this.#forgetClosing(terminalId, entry.threadId, closing),
    )
    return closing
  }

  async #finishClose(
    entry: TerminalEntry,
    owned: boolean,
    exitedInTime: Promise<void>,
    job: Job | undefined,
  ): Promise<void> {
    // A shell that ignores SIGHUP would keep its PTY and job alive and fail the
    // close at its timeout; a closed terminal emulator would at least have
    // hung up its line. Ask again first: a pid that is no longer our session
    // leader is not ours to kill.
    if (
      owned &&
      !(await this.#settlesWithin(entry.exited, 'hangup')) &&
      this.#ownedShell(entry.process.pid)
    ) {
      try {
        entry.process.kill('SIGKILL')
      } catch {
        // The exit, or the bounded close timeout, reports the outcome.
      }
    }
    await exitedInTime
    // The shell's exit sent its foreground job SIGHUP. Background jobs are
    // left to the shell, as a terminal emulator leaves them.
    if (job !== undefined) await this.#stopJob(job)
  }

  async #stopJob(job: Job): Promise<void> {
    if ((await this.#awaitJob(job, 'hangup')) !== 'running') return
    this.#jobControl.signal(job.group, 'SIGTERM')
    if ((await this.#awaitJob(job, 'terminate')) !== 'running') return
    this.#jobControl.signal(job.group, 'SIGKILL')
    if ((await this.#awaitJob(job, 'kill')) !== 'running') return
    throw new Error(`terminal job ${job.group} did not stop after SIGKILL`)
  }

  /**
   * Wait up to one step for the job to end. `running` means it is still the
   * closed shell's job, read just now, so the caller may signal it.
   */
  async #awaitJob(job: Job, step: CloseStep): Promise<'ended' | 'running' | 'foreign'> {
    const startedAt = Date.now()
    while (true) {
      // Members that exited stay in the group as zombies until their new
      // parent reaps them, which a container's pid 1 may do only lazily.
      const members = (await this.#jobControl.members(job.group))?.filter(
        (member) => !member.zombie,
      )
      // A group that cannot be read is not escalated blindly.
      if (!members || members.length === 0) return 'ended'
      // A recycled group id now names someone else's processes.
      if (members.some((member) => member.session !== job.session)) return 'foreign'
      if (Date.now() - startedAt >= this.#stepMs(step)) return 'running'
      await delay(CLOSE_POLL_MS)
    }
  }

  /** Whether `promise` settles within a step; a shutdown shortens the step. */
  async #settlesWithin(promise: Promise<void>, step: CloseStep): Promise<boolean> {
    const settled = promise.then(() => true)
    const startedAt = Date.now()
    while (true) {
      const remaining = this.#stepMs(step) - (Date.now() - startedAt)
      if (remaining <= 0) return false
      const tick = delay(Math.min(remaining, CLOSE_POLL_MS)).then(() => false)
      if (await Promise.race([settled, tick])) return true
    }
  }

  #stepMs(step: CloseStep): number {
    return (this.#closingAll ? SHUTDOWN_STEPS : CLOSE_STEPS)[step]
  }

  /** The shell behind a PTY, only when this server forked it as a session leader. */
  #ownedShell(pid: number): ShellProcess | undefined {
    const shell = this.#inspectShell(pid)
    // A stale or foreign pid must never become authority to signal a group.
    return shell?.leader && shell.parent === globalThis.process.pid && shell.group === pid
      ? shell
      : undefined
  }

  closeThread(threadId: string): Promise<void> {
    const alreadyClosing = this.#closingThreads.get(threadId)
    if (alreadyClosing) return alreadyClosing

    const closing = this.#drainThread(threadId)
    this.#closingThreads.set(threadId, closing)
    void closing.then(
      () => this.#closingThreads.delete(threadId),
      () => this.#closingThreads.delete(threadId),
    )
    return closing
  }

  closeAll(): Promise<void> {
    if (this.#closingAll) return this.#closingAll
    this.#closingAll = this.#drainAll()
    return this.#closingAll
  }

  async #drainThread(threadId: string): Promise<void> {
    const waits = new Set(this.#closingByThread.get(threadId) ?? [])
    for (const [terminalId, entry] of this.#byId) {
      if (entry.threadId !== threadId) continue
      try {
        waits.add(this.close(terminalId))
      } catch (error) {
        waits.add(Promise.reject(error))
      }
    }
    await settleAll(waits, `terminal shutdown failed for ${threadId}`)
  }

  async #drainAll(): Promise<void> {
    const waits = new Set<Promise<void>>(this.#closingById.values())
    for (const closingThread of this.#closingThreads.values()) waits.add(closingThread)
    for (const terminalId of this.#byId.keys()) {
      try {
        waits.add(this.close(terminalId))
      } catch (error) {
        waits.add(Promise.reject(error))
      }
    }
    await settleAll(waits, 'terminal shutdown failed')
  }

  #boundedExit(terminalId: string, exited: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`terminal shutdown timed out: ${terminalId}`)),
        this.#closeTimeoutMs,
      )
      void exited.then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  #forgetClosing(terminalId: string, threadId: string, closing: Promise<void>): void {
    if (this.#closingById.get(terminalId) === closing) this.#closingById.delete(terminalId)
    const threadClosings = this.#closingByThread.get(threadId)
    threadClosings?.delete(closing)
    if (threadClosings?.size === 0) this.#closingByThread.delete(threadId)
  }

  #get(terminalId: string): TerminalEntry {
    const entry = this.#byId.get(terminalId)
    if (!entry) throw new Error(`no such terminal: ${terminalId}`)
    return entry
  }
}

async function settleAll(waiters: Iterable<Promise<void>>, message: string): Promise<void> {
  const results = await Promise.allSettled(waiters)
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length > 0) throw new AggregateError(errors, message)
}

/** A poll sleep that never keeps a closing server alive on its own. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}

const processGroups: JobControl = {
  async members(group) {
    try {
      globalThis.process.kill(-group, 0)
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return []
    }
    try {
      // One -o per column: BSD ps on macOS takes everything after the first
      // `=` as that column's header.
      const { stdout } = await execFileAsync(
        'ps',
        ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'sess=', '-o', 'stat='],
        {
          encoding: 'utf8',
          timeout: 1_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      )
      return stdout.split('\n').flatMap((line) => {
        const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/.exec(line)
        return row && Number(row[2]) === group
          ? [{ pid: Number(row[1]), session: row[3]!, zombie: row[4]!.startsWith('Z') }]
          : []
      })
    } catch {
      return undefined
    }
  },
  signal(group, signal) {
    try {
      globalThis.process.kill(-group, signal)
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') throw error
    }
  },
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function isFolder(folder: string): boolean {
  return statSync(folder, { throwIfNoEntry: false })?.isDirectory() ?? false
}

/**
 * Read a shell's parent, process group, terminal foreground group and session.
 *
 * Windows has no process groups to escalate: closing a ConPTY makes node-pty
 * terminate every process attached to that console.
 */
function inspectShell(pid: number): ShellProcess | undefined {
  if (globalThis.process.platform === 'win32') return undefined
  // One -o per column: BSD ps on macOS takes everything after the first `=`
  // as that column's header, so `-o ppid=,pgid=` would print one column.
  const result = spawnSync(
    'ps',
    ['-o', 'ppid=', '-o', 'pgid=', '-o', 'tpgid=', '-o', 'sess=', '-o', 'stat=', '-p', String(pid)],
    { encoding: 'utf8', timeout: 1_000 },
  )
  if (result.error || result.status !== 0) return undefined
  const fields = result.stdout.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const [parent, group, foreground] = fields.slice(0, 3).map(Number) as [number, number, number]
  if (![parent, group, foreground].every(Number.isInteger)) return undefined
  // Not every ps prints the session as its leader's pid, so it is only ever
  // compared, never parsed.
  const [session, state] = fields.slice(3) as [string, string]
  return { parent, group, foreground, session, leader: state.includes('s') }
}

export function platformShell(
  platform: NodeJS.Platform = globalThis.process.platform,
  environment: NodeJS.ProcessEnv = globalThis.process.env,
): string {
  if (platform === 'win32') return environment['ComSpec'] ?? environment['COMSPEC'] ?? 'cmd.exe'
  return environment['SHELL'] ?? '/bin/sh'
}

export function terminalEnvironment(
  environment: NodeJS.ProcessEnv = globalThis.process.env,
): NodeJS.ProcessEnv {
  const env = {
    ...environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'TasteCode',
  }
  applyDesktopPath(env)
  return env
}
