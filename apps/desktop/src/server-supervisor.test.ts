import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { OWNED_PROCESS_SHUTDOWN_MESSAGE } from '@harness/proc'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CONSECUTIVE_FAILURES, restartDelayMs, ServerSupervisor } from './server-supervisor.js'

class FakeChild extends ChildProcess {
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  wasKilled = false
  override kill(): boolean {
    this.wasKilled = true
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

  it('stop kills the child and cancels any pending restart', async () => {
    const { sup, children } = supervisor()
    sup.start()
    children[0]!.emit('exit', 1, null)
    await sup.stop()
    vi.advanceTimersByTime(60_000)
    expect(children).toHaveLength(1)

    const again = supervisor()
    again.sup.start()
    const stopping = again.sup.stop()
    expect(stopping).toBeInstanceOf(Promise)
    expect(again.children[0]!.wasKilled).toBe(true)
    again.children[0]!.emit('exit', 0, null)
    await stopping
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

  it('stop stays pending until the server confirms a clean exit', async () => {
    const { sup, children } = supervisor()
    sup.start()
    let settled = false
    const stopping = sup.stop().then(() => {
      settled = true
    })
    expect(children[0]!.wasKilled).toBe(true)
    expect(settled).toBe(false)

    // Still within the bounded wait: no exit yet, so stop must not resolve.
    vi.advanceTimersByTime(1_000)
    expect(settled).toBe(false)

    children[0]!.emit('exit', 0, null)
    await stopping
    expect(settled).toBe(true)

    // Restart stays suppressed after the late exit.
    vi.advanceTimersByTime(60_000)
    expect(children).toHaveLength(1)
  })

  it('does not report successful shutdown when the server never exits', async () => {
    const { sup } = supervisor()
    sup.start()

    const stopped = sup.stop()
    const rejected = expect(stopped).rejects.toThrow(/did not exit/i)
    await vi.advanceTimersByTimeAsync(60_000)

    await rejected
  })

  it('reports a failed server cleanup', async () => {
    const { sup, children } = supervisor()
    sup.start()

    const stopped = sup.stop()
    children[0]!.emit('exit', 1, null)

    await expect(stopped).rejects.toThrow(/code 1/i)
  })

  it('waits for real child cleanup requested over IPC', async () => {
    vi.useRealTimers()
    const logs: string[] = []
    let ready: (() => void) | undefined
    const listening = new Promise<void>((resolve) => {
      ready = resolve
    })
    const sup = new ServerSupervisor({
      command: process.execPath,
      args: [
        '-e',
        `process.on('message', message => {
          if (message !== ${JSON.stringify(OWNED_PROCESS_SHUTDOWN_MESSAGE)}) return
          process.stdout.write('cleanup complete\\n')
          process.exit(0)
        })
        process.stdout.write('ready\\n')`,
      ],
      env: process.env,
      onLog: (line) => {
        logs.push(line)
        if (line === 'ready') ready?.()
      },
    })

    sup.start()
    await listening
    await sup.stop()

    expect(logs).toContain('cleanup complete')
  })
})
