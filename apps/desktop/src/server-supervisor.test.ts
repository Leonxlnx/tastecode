import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_CONSECUTIVE_FAILURES,
  restartDelayMs,
  ServerSupervisor,
  type SupervisedServerProcess,
} from './server-supervisor.js'

class FakeChild extends ChildProcess {
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  wasKilled = false
  override kill(): boolean {
    this.wasKilled = true
    return true
  }
}

function supervised(child: FakeChild): SupervisedServerProcess {
  return {
    pid: child.pid,
    exitCode: null,
    signalCode: null,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    onError: (listener) => child.on('error', (error) => listener(error)),
    onExit: (listener) => child.on('exit', listener),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('restartDelayMs', () => {
  it('backs off exponentially and caps at 15s', () => {
    expect(restartDelayMs(1)).toBe(500)
    expect(restartDelayMs(2)).toBe(1_000)
    expect(restartDelayMs(4)).toBe(4_000)
    expect(restartDelayMs(6)).toBe(15_000)
    expect(restartDelayMs(50)).toBe(15_000)
  })
})

describe('ServerSupervisor', () => {
  function supervisor() {
    const children: FakeChild[] = []
    const logs: string[] = []
    const gaveUp = vi.fn()
    const sup = new ServerSupervisor({
      command: 'node',
      args: ['server.js'],
      env: {},
      onLog: (line) => logs.push(line),
      onGaveUp: gaveUp,
      spawnFn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
    })
    return { sup, children, logs, gaveUp }
  }

  it('restarts a dying server with backoff', () => {
    const { sup, children } = supervisor()
    sup.start()
    expect(children).toHaveLength(1)

    children[0]!.emit('exit', 1, null)
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(500)
    expect(children).toHaveLength(2)

    children[1]!.emit('exit', 1, null)
    vi.advanceTimersByTime(999)
    expect(children).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(3)
  })

  it('a long healthy run resets the backoff', () => {
    const { sup, children } = supervisor()
    sup.start()
    children[0]!.emit('exit', 1, null)
    vi.advanceTimersByTime(500)
    // Second run stays up well past the healthy threshold before dying.
    vi.advanceTimersByTime(60_000)
    children[1]!.emit('exit', 1, null)
    vi.advanceTimersByTime(500)
    expect(children).toHaveLength(3)
  })

  it('gives up after enough consecutive failures and says so once', () => {
    const { sup, children, gaveUp } = supervisor()
    sup.start()
    for (let round = 0; round <= MAX_CONSECUTIVE_FAILURES; round++) {
      children[children.length - 1]!.emit('exit', 1, null)
      vi.advanceTimersByTime(15_000)
    }
    expect(gaveUp).toHaveBeenCalledOnce()
    expect(children.length).toBe(MAX_CONSECUTIVE_FAILURES + 1)
  })

  it('stop kills the child and cancels any pending restart', () => {
    const { sup, children } = supervisor()
    sup.start()
    children[0]!.emit('exit', 1, null)
    sup.stop()
    vi.advanceTimersByTime(60_000)
    expect(children).toHaveLength(1)

    const again = supervisor()
    again.sup.start()
    again.sup.stop()
    expect(again.children[0]!.wasKilled).toBe(true)
    again.children[0]!.emit('exit', null, 'SIGTERM')
    vi.advanceTimersByTime(60_000)
    expect(again.children).toHaveLength(1)
  })

  it('treats error followed by exit as one failed run', () => {
    const { sup, children } = supervisor()
    sup.start()

    children[0]!.emit('error', new Error('spawn failed'))
    vi.advanceTimersByTime(500)
    expect(children).toHaveLength(2)

    // Node may emit exit after error. A late exit from the old child must not
    // make the supervisor forget the healthy replacement and spawn a third.
    children[0]!.emit('exit', 1, null)
    vi.advanceTimersByTime(1_000)

    expect(children).toHaveLength(2)
  })

  it('forwards child output line by line', () => {
    const { sup, children, logs } = supervisor()
    sup.start()
    children[0]!.stdout.write('listening on 4311\npartial')
    expect(logs).toContain('listening on 4311')
  })

  it('holds a line split across chunks until the rest arrives', () => {
    const { sup, children, logs } = supervisor()
    sup.start()
    children[0]!.stdout.write('listen')
    expect(logs).toHaveLength(0)
    children[0]!.stdout.write('ing on 4311\nnext\n')
    expect(logs).toEqual(['listening on 4311', 'next'])
  })

  it('buffers partial lines per stream instead of interleaving them', () => {
    const { sup, children, logs } = supervisor()
    sup.start()
    children[0]!.stdout.write('out-a')
    children[0]!.stderr.write('err-b\n')
    children[0]!.stdout.write('-done\n')
    expect(logs).toEqual(['err-b', 'out-a-done'])
  })

  it('flushes a trailing unterminated line when a stream ends', () => {
    const { sup, children, logs } = supervisor()
    sup.start()
    children[0]!.stderr.write('fatal: boom')
    children[0]!.stderr.emit('end')
    expect(logs).toContain('fatal: boom')
  })

  it('counts a synchronous launch throw as a failed run instead of crashing', () => {
    const logs: string[] = []
    const gaveUp = vi.fn()
    const launch = vi.fn((): SupervisedServerProcess => {
      throw new Error('fork failed')
    })
    const sup = new ServerSupervisor({
      launch,
      onLog: (line) => logs.push(line),
      onGaveUp: gaveUp,
    })

    expect(() => sup.start()).not.toThrow()
    expect(logs.some((line) => line.includes('fork failed'))).toBe(true)

    vi.advanceTimersByTime(500)
    expect(launch).toHaveBeenCalledTimes(2)
  })

  it('gives up after repeated synchronous launch throws', () => {
    const gaveUp = vi.fn()
    const launch = vi.fn((): SupervisedServerProcess => {
      throw new Error('fork failed')
    })
    const sup = new ServerSupervisor({ launch, onLog: () => {}, onGaveUp: gaveUp })

    sup.start()
    for (let round = 0; round < MAX_CONSECUTIVE_FAILURES; round++) {
      vi.advanceTimersByTime(15_000)
    }
    expect(gaveUp).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES + 1)
  })

  function supervisorWith(hooks: {
    onSpawned?: (pid: number | undefined) => void
    onEarlyExit?: () => Promise<'restart' | 'stop'> | 'restart' | 'stop'
  }) {
    const children: FakeChild[] = []
    const gaveUp = vi.fn()
    const sup = new ServerSupervisor({
      command: 'node',
      args: ['server.js'],
      env: {},
      onLog: () => {},
      onGaveUp: gaveUp,
      ...hooks,
      spawnFn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
    })
    return { sup, children, gaveUp }
  }

  it('reports each spawned pid through onSpawned', () => {
    const spawned: (number | undefined)[] = []
    const { sup, children } = supervisorWith({ onSpawned: (pid) => spawned.push(pid) })
    sup.start()
    children[0]!.emit('exit', 1, null)
    vi.advanceTimersByTime(500)
    expect(spawned).toHaveLength(2)
  })

  it('consults onEarlyExit on the first early death and stops when told', async () => {
    const onEarlyExit = vi.fn(() => 'stop' as const)
    const { sup, children, gaveUp } = supervisorWith({ onEarlyExit })
    sup.start()
    children[0]!.emit('exit', 1, null)
    await Promise.resolve()
    vi.advanceTimersByTime(60_000)
    expect(onEarlyExit).toHaveBeenCalledTimes(1)
    expect(children).toHaveLength(1)
    expect(gaveUp).not.toHaveBeenCalled()
  })

  it('resumes the backoff path when onEarlyExit returns restart', async () => {
    const onEarlyExit = vi.fn(() => 'restart' as const)
    const { sup, children } = supervisorWith({ onEarlyExit })
    sup.start()
    children[0]!.emit('exit', 1, null)
    await Promise.resolve()
    vi.advanceTimersByTime(500)
    expect(onEarlyExit).toHaveBeenCalledTimes(1)
    expect(children).toHaveLength(2)

    // The consult happens once: a second early death goes straight to backoff.
    children[1]!.emit('exit', 1, null)
    await Promise.resolve()
    vi.advanceTimersByTime(1_000)
    expect(onEarlyExit).toHaveBeenCalledTimes(1)
    expect(children).toHaveLength(3)
  })

  it('does not consult onEarlyExit for a run that reached the healthy threshold', async () => {
    const onEarlyExit = vi.fn(() => 'stop' as const)
    const { sup, children } = supervisorWith({ onEarlyExit })
    sup.start()
    vi.advanceTimersByTime(60_000)
    children[0]!.emit('exit', 1, null)
    await Promise.resolve()
    vi.advanceTimersByTime(500)
    expect(onEarlyExit).not.toHaveBeenCalled()
    expect(children).toHaveLength(2)
  })

  it('a stop during the early-exit consult prevents the restart', async () => {
    let decide: ((decision: 'restart' | 'stop') => void) | undefined
    const { sup, children } = supervisorWith({
      onEarlyExit: () =>
        new Promise<'restart' | 'stop'>((resolve) => {
          decide = resolve
        }),
    })
    sup.start()
    children[0]!.emit('exit', 1, null)
    await Promise.resolve()
    sup.stop()
    decide!('restart')
    await Promise.resolve()
    vi.advanceTimersByTime(60_000)
    expect(children).toHaveLength(1)
  })

  it('supervises an Electron utility-process launcher', () => {
    const children: FakeChild[] = []
    const logs: string[] = []
    const launch = vi.fn(() => {
      const child = new FakeChild()
      children.push(child)
      return supervised(child)
    })
    const sup = new ServerSupervisor({ launch, onLog: (line) => logs.push(line) })

    sup.start()
    children[0]!.stdout.write('listening on 4311\n')
    expect(logs).toContain('listening on 4311')

    children[0]!.emit('exit', 1, null)
    vi.advanceTimersByTime(500)
    expect(launch).toHaveBeenCalledTimes(2)

    sup.stop()
    expect(children[1]!.wasKilled).toBe(true)
  })
})
