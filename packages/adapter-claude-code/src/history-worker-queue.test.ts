import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Workers the test answers and ends by hand, in the order the source started them. */
const started = vi.hoisted(() => [] as FakeWorker[])
type FakeWorker = EventEmitter & {
  title: string
  exited: boolean
  terminated: boolean
  terminate(): Promise<number>
  exit(): void
}

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  // Mocks are set up before this file's imports.
  const { EventEmitter } = await import('node:events')
  class Worker extends EventEmitter {
    title: string
    exited = false
    terminated = false
    #exit = Promise.withResolvers<number>()
    constructor(_url: URL, options: { workerData: { session: { title: string } } }) {
      super()
      this.title = options.workerData.session.title
      started.push(this as unknown as FakeWorker)
    }
    /** Asks the worker to stop; it exits when the test says so. */
    terminate() {
      this.terminated = true
      return this.#exit.promise
    }
    exit() {
      this.exited = true
      this.emit('exit', 1)
      this.#exit.resolve(1)
    }
  }
  return { ...actual, Worker }
})

const { createClaudeHistorySource } = await import('./history.js')

const SESSION = '33333333-3333-4333-8333-333333333333'
const directories: string[] = []

afterEach(async () => {
  started.length = 0
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function source() {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-worker-queue-'))
  directories.push(configDir)
  const project = path.join(configDir, 'projects', '-queue')
  await mkdir(project, { recursive: true })
  const file = path.join(project, `${SESSION}.jsonl`)
  await writeFile(file, '{"type":"summary"}\n')
  const history = createClaudeHistorySource({
    configDir,
    readWorker: { fromBytes: 0, url: new URL('file:///unused.js') },
  })
  const session = {
    id: SESSION,
    locator: file,
    revision: 'r',
    workspacePath: configDir,
    title: 'first',
    createdAt: 0,
    updatedAt: 0,
  }
  return { history, session }
}

const answer = (worker: FakeWorker) =>
  worker.emit('message', {
    events: [{ type: 'thread.started', thread: { id: SESSION, title: worker.title } }],
  })

describe('Claude history worker queue', () => {
  it('starts the next worker only once the one before has exited', async () => {
    const { history, session } = await source()
    const first = history.read(session)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const second = history.read({ ...session, title: 'second' })

    answer(started[0]!)
    expect(await first).toEqual([
      { type: 'thread.started', thread: { id: SESSION, title: 'first' } },
    ])
    // Answered and asked to stop, but not gone yet: its slot is still held.
    expect(started[0]!.terminated).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toHaveLength(1)

    started[0]!.exit()
    await vi.waitFor(() => expect(started).toHaveLength(2))
    answer(started[1]!)
    started[1]!.exit()
    expect(await second).toEqual([
      { type: 'thread.started', thread: { id: SESSION, title: 'second' } },
    ])
  })

  it('waits on dispose for a worker that answered but has not exited', async () => {
    const { history, session } = await source()
    const read = history.read(session)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    answer(started[0]!)
    await read
    let disposed = false
    const disposing = Promise.resolve(history.dispose?.()).then(() => (disposed = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(disposed).toBe(false)
    started[0]!.exit()
    await disposing
    expect(disposed).toBe(true)
  })

  it('releases the slot when a worker fails', async () => {
    const { history, session } = await source()
    const failing = history.read(session)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    started[0]!.emit('error', new Error('worker crashed'))
    await expect(failing).rejects.toThrow('worker crashed')
    started[0]!.exit()

    const other = await source()
    const next = other.history.read({ ...other.session, title: 'next' })
    await vi.waitFor(() => expect(started).toHaveLength(2))
    answer(started[1]!)
    started[1]!.exit()
    await expect(next).resolves.toHaveLength(1)
  })
})
