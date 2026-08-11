import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CONSECUTIVE_FAILURES, restartDelayMs, ServerSupervisor } from './server-supervisor.js'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
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
      spawnFn: (() => {
        const child = new FakeChild()
        children.push(child)
        return child
      }) as never,
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
    expect(again.children[0]!.killed).toBe(true)
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
})
