import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import type { IPty, spawn as NodePtySpawn } from 'node-pty'
import { applyDesktopPath } from '@harness/proc/desktop-path'

const DEFAULT_CLOSE_TIMEOUT_MS = 10_000
// A pane or chat close: how long each step may take, counted from its start.
// After SIGHUP the shell gets `hangup` to exit before SIGKILL. Once it is gone
// its foreground job gets `hangup` to exit on its own, then `terminate` after
// SIGTERM and `kill` after SIGKILL before the close gives up and logs it.
const CLOSE_STEPS = { hangup: 3_000, terminate: 3_000, kill: 1_000 }
// Server shutdown: the latest each step may end, counted from closeAll(), so
// the last SIGKILL goes out about two seconds in, inside the desktop's
// three-second force stop. Most of it belongs to SIGTERM: servers such as
// gunicorn, nginx or postgres reload on SIGHUP and shut down cleanly only on
// SIGTERM.
const SHUTDOWN_STEP_ENDS = { hangup: 200, terminate: 2_000, kill: 2_300 }
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
 * One POSIX process as `ps` reports it: its parent, process group, its
 * terminal's foreground group, its session, whether it leads that session, and
 * whether it has exited and only waits to be reaped.
 */
type ProcessRow = {
  pid: number
  parent: number
  group: number
  foreground: number
  /**
   * Only ever compared. Linux prints the session id; macOS prints 0 for every
   * process, so there the session re-check of a job guards nothing.
   */
  session: string
  leader: boolean
  zombie: boolean
}
/** Reads and signals POSIX processes; injectable so tests need no real job. */
type Processes = {
  /**
   * These processes, read synchronously: a close has to learn which job holds
   * the terminal before node-pty hangs it up.
   */
  inspect(pids: number[]): ProcessRow[]
  /** Every process, or undefined when they cannot be listed. */
  list(): Promise<ProcessRow[] | undefined>
  signal(group: number, signal: NodeJS.Signals): void
}
type CloseStep = keyof typeof CLOSE_STEPS
/** The foreground process group of a closed shell, and that shell's session. */
type Job = { group: number; session: string }
type JobState = 'ended' | 'running' | 'foreign' | 'unreadable'
const JOB_LEFT = {
  running: 'it survived SIGKILL',
  foreign: 'its group now holds another session',
  unreadable: 'its processes could not be listed',
} satisfies Record<Exclude<JobState, 'ended'>, string>
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
  /** When closeAll() began. Steps run on performance.now(), which a clock change cannot move. */
  #shutdownStartedAt: number | undefined
  /** How many ps listings have started; orders each listing against a step's start. */
  #listingsStarted = 0
  #listing: { number: number; rows: Promise<ProcessRow[] | undefined> } | undefined
  /** Wakes every pending poll, so a starting shutdown shortens it at once. */
  #wakers = new Set<() => void>()
  /** Jobs of closed terminals still being stopped; only shutdown waits for them. */
  #stoppingJobs = new Set<Promise<void>>()
  /** Closes still waiting on their shell; a starting shutdown hands their jobs over. */
  #pendingHandOvers = new Set<() => void>()
  #onOutput: (terminalId: string, data: string, outputOffset: number) => void
  #onExit: (terminalId: string, exitCode: number | null) => void
  #onLog: (message: string) => void
  #spawnPty: SpawnPty
  #processes: Processes
  #closeTimeoutMs: number
  readonly #outputScheduler = new TerminalOutputScheduler()
  #status = new Map<string, TerminalStatus & { finishedAt?: number }>()

  constructor(
    handlers: {
      onOutput: (terminalId: string, data: string, outputOffset: number) => void
      onExit: (terminalId: string, exitCode: number | null) => void
      onLog?: (message: string) => void
    },
    options: {
      spawnPty?: SpawnPty
      processes?: Processes
      closeTimeoutMs?: number
    } = {},
  ) {
    this.#onOutput = handlers.onOutput
    this.#onExit = handlers.onExit
    this.#onLog = handlers.onLog ?? (() => {})
    this.#spawnPty = options.spawnPty ?? spawnPty
    this.#processes = options.processes ?? processTable
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
    return this.#closeEntry(terminalId, entry, this.#processes.inspect([entry.process.pid]))
  }

  /**
   * Close several terminals with one ps for all their shells: inspecting them
   * one by one would hold up each hangup by every inspection before it.
   */
  #closeEntries(entries: Array<[string, TerminalEntry]>, waits: Set<Promise<void>>): void {
    const rows = this.#processes.inspect(entries.map(([, entry]) => entry.process.pid))
    for (const [terminalId, entry] of entries) {
      try {
        waits.add(this.#closeEntry(terminalId, entry, rows))
      } catch (error) {
        waits.add(Promise.reject(error))
      }
    }
  }

  #closeEntry(terminalId: string, entry: TerminalEntry, rows: ProcessRow[]): Promise<void> {
    // node-pty only sends SIGHUP, which a foreground job may ignore — a server
    // that treats it as "reload" outlives the pane. Read which job holds the
    // terminal now: once the shell exits, nothing records it.
    const shell = ownedShell(rows, entry.process.pid)
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
    // gone. Keep that generation tracked until its real exit arrives, so a
    // retry or shutdown waits for it.
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
    let exited = false
    void entry.exited.then(() => (exited = true))
    // The shell's grace starts now, right after its hangup.
    const listedBefore = this.#listingsStarted
    // During shutdown the job's steps end at fixed times anyway, and node-pty
    // may report the shell's exit 200 ms late while the job holds the
    // terminal open: hand the job over as soon as shutdown starts, even while
    // this close still waits on its shell, so its SIGTERM is not late.
    let handedOver = false
    const handOver = () => {
      this.#pendingHandOvers.delete(handOver)
      if (job === undefined || handedOver) return
      handedOver = true
      this.#trackJob(job)
    }
    if (this.#shutdownStartedAt !== undefined) handOver()
    else if (job !== undefined) this.#pendingHandOvers.add(handOver)
    try {
      if (owned && !(await this.#settlesWithin(entry.exited, 'hangup'))) {
        const pid = entry.process.pid
        const rows = (await this.#listProcesses(listedBefore)) ?? this.#processes.inspect([pid])
        if (!exited && ownedShell(rows, pid)) {
          try {
            entry.process.kill('SIGKILL')
          } catch {
            // The exit, or the bounded close timeout, reports the outcome.
          }
        }
      }
      await exitedInTime
    } finally {
      this.#pendingHandOvers.delete(handOver)
    }
    // The shell's exit sent its foreground job SIGHUP. Background jobs are
    // left to the shell, as a terminal emulator leaves them. The close is done
    // once the shell is gone: the job may take seconds to shut down, and the
    // chat may already open a new terminal meanwhile.
    handOver()
  }

  #trackJob(job: Job): void {
    const stopping = this.#stopJob(job)
    this.#stoppingJobs.add(stopping)
    const forget = () => this.#stoppingJobs.delete(stopping)
    void stopping.then(forget, forget)
  }

  /**
   * Stop what is left of the job. A job that cannot be stopped — a member
   * owned by root, one stuck in the kernel — is logged rather than failing
   * the close: the pane, chat or server is gone either way.
   */
  async #stopJob(job: Job): Promise<void> {
    try {
      let state = await this.#awaitJob(job, 'hangup')
      if (state === 'running') {
        this.#processes.signal(job.group, 'SIGTERM')
        state = await this.#awaitJob(job, 'terminate')
      }
      if (state === 'running') {
        this.#processes.signal(job.group, 'SIGKILL')
        state = await this.#awaitJob(job, 'kill')
      }
      if (state !== 'ended') {
        this.#onLog(`[terminal] left job ${job.group} of a closed terminal: ${JOB_LEFT[state]}`)
      }
    } catch (error) {
      this.#onLog(
        `[terminal] could not stop job ${job.group} of a closed terminal: ${errorMessage(error)}`,
      )
    }
  }

  /**
   * Wait up to one step for the job to end. `running` means it is still the
   * closed shell's job, read just now, so the caller may signal it.
   */
  async #awaitJob(job: Job, step: CloseStep): Promise<JobState> {
    const startedAt = performance.now()
    const listedBefore = this.#listingsStarted
    while (true) {
      // Members that exited stay in the group as zombies until their new
      // parent reaps them, which a container's pid 1 may do only lazily.
      const members = (await this.#listProcesses(listedBefore))?.filter(
        (row) => row.group === job.group && !row.zombie,
      )
      if (members?.length === 0) return 'ended'
      // A recycled group id now names someone else's processes. Linux only:
      // on macOS every member and the shell report session 0.
      if (members?.some((member) => member.session !== job.session)) return 'foreign'
      const left = this.#stepEnd(step, startedAt) - performance.now()
      // A failed listing is retried on the next poll, but a group that still
      // cannot be read when the step ends is not escalated blindly.
      if (left <= 0) return members ? 'running' : 'unreadable'
      await this.#pause(left)
    }
  }

  /** Whether `promise` settles within a step; a shutdown shortens the step. */
  async #settlesWithin(promise: Promise<void>, step: CloseStep): Promise<boolean> {
    let settled = false
    void promise.then(() => (settled = true))
    const startedAt = performance.now()
    while (!settled) {
      const left = this.#stepEnd(step, startedAt) - performance.now()
      if (left <= 0) return false
      await this.#pause(left, promise)
    }
    return true
  }

  /** When a step that started at `startedAt` ends at the latest. */
  #stepEnd(step: CloseStep, startedAt: number): number {
    const end = startedAt + CLOSE_STEPS[step]
    if (this.#shutdownStartedAt === undefined) return end
    return Math.min(end, this.#shutdownStartedAt + SHUTDOWN_STEP_ENDS[step])
  }

  /**
   * Sleep one poll, never past the time left in the step, and wake early when
   * `wake` settles or a shutdown starts. The timer keeps the process alive:
   * once a shutting-down server has closed everything else, an unreferenced
   * one would let it exit mid-close and leave the job running.
   */
  #pause(left: number, wake?: Promise<unknown>): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.#wakers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.min(left, CLOSE_POLL_MS))
      this.#wakers.add(done)
      void wake?.then(done, done)
    })
  }

  /**
   * One ps listing, shared by every poll that asks for one while it runs, as
   * long as it is not among the first `listedBefore` listings: one begun
   * before a step started cannot show what the signal opening that step did.
   * Counting listings, not milliseconds, also keeps out one begun in the same
   * millisecond as the signal.
   */
  #listProcesses(listedBefore: number): Promise<ProcessRow[] | undefined> {
    if (this.#listing && this.#listing.number > listedBefore) return this.#listing.rows
    this.#listingsStarted += 1
    const listing = { number: this.#listingsStarted, rows: this.#processes.list() }
    this.#listing = listing
    const forget = () => {
      if (this.#listing === listing) this.#listing = undefined
    }
    void listing.rows.then(forget, forget)
    return listing.rows
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
    this.#shutdownStartedAt = performance.now()
    // Each hand-over and waker removes itself; a Set iterator tolerates that.
    for (const handOver of this.#pendingHandOvers) handOver()
    for (const wake of this.#wakers) wake()
    this.#closingAll = this.#drainAll()
    return this.#closingAll
  }

  async #drainThread(threadId: string): Promise<void> {
    const waits = new Set(this.#closingByThread.get(threadId) ?? [])
    this.#closeEntries(
      [...this.#byId].filter(([, entry]) => entry.threadId === threadId),
      waits,
    )
    await settleAll(waits, `terminal shutdown failed for ${threadId}`)
  }

  async #drainAll(): Promise<void> {
    const waits = new Set<Promise<void>>(this.#closingById.values())
    for (const closingThread of this.#closingThreads.values()) waits.add(closingThread)
    this.#closeEntries([...this.#byId], waits)
    try {
      await settleAll(waits, 'terminal shutdown failed')
    } finally {
      // Every close that saw its shell exit has handed over its job by now.
      await Promise.allSettled(this.#stoppingJobs)
    }
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

/** The shell behind a PTY, only when this server forked it as a session leader. */
function ownedShell(rows: ProcessRow[], pid: number): ProcessRow | undefined {
  const shell = rows.find((row) => row.pid === pid)
  // A stale or foreign pid must never become authority to signal a group.
  return shell?.leader && shell.parent === globalThis.process.pid && shell.group === pid
    ? shell
    : undefined
}

async function settleAll(waiters: Iterable<Promise<void>>, message: string): Promise<void> {
  const results = await Promise.allSettled(waiters)
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length > 0) throw new AggregateError(errors, message)
}

// One -o per column: BSD ps on macOS takes everything after the first `=` as
// that column's header, so `-o pid=,ppid=` would print one column.
const PS_COLUMNS = ['pid=', 'ppid=', 'pgid=', 'tpgid=', 'sess=', 'stat='].flatMap((column) => [
  '-o',
  column,
])

/**
 * Windows has no process groups to escalate: closing a ConPTY makes node-pty
 * terminate every process attached to that console.
 */
const processTable: Processes = {
  inspect(pids) {
    if (globalThis.process.platform === 'win32' || pids.length === 0) return []
    const result = spawnSync('ps', [...PS_COLUMNS, '-p', pids.join(',')], {
      encoding: 'utf8',
      timeout: 1_000,
    })
    return result.error ? [] : processRows(result.stdout)
  },
  async list() {
    try {
      const { stdout } = await execFileAsync('ps', ['-A', ...PS_COLUMNS], {
        encoding: 'utf8',
        timeout: 1_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      return processRows(stdout)
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

function processRows(stdout: string): ProcessRow[] {
  return stdout.split('\n').flatMap((line) => {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 6) return []
    const [pid, parent, group, foreground] = fields.slice(0, 4).map(Number)
    const [session = '', state = ''] = fields.slice(4)
    if (![pid, parent, group, foreground].every(Number.isInteger)) return []
    return [
      {
        pid: pid!,
        parent: parent!,
        group: group!,
        foreground: foreground!,
        session,
        leader: state.includes('s'),
        zombie: state.startsWith('Z'),
      },
    ]
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function isFolder(folder: string): boolean {
  return statSync(folder, { throwIfNoEntry: false })?.isDirectory() ?? false
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
