import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportsBehindReads } from './imports-behind-reads.js'

afterEach(() => {
  vi.useRealTimers()
})

function imports(outcomes: Array<boolean | Error>) {
  const loads: string[] = []
  const changed: string[] = []
  const service = new ImportsBehindReads({
    load: async (threadId) => {
      loads.push(threadId)
      const outcome = outcomes.shift() ?? false
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    changed: (threadId) => changed.push(threadId),
    retryDelaysMs: [100, 1_000],
  })
  return { service, loads, changed }
}

describe('imports behind a read', () => {
  it('retries a failed import so the open chat catches up, and announces it once', async () => {
    vi.useFakeTimers()
    const { service, loads, changed } = imports([new Error('worker failed'), true])
    service.start('chat')
    await vi.advanceTimersByTimeAsync(0)
    expect(loads).toEqual(['chat'])
    expect(changed).toEqual([])

    await vi.advanceTimersByTimeAsync(100)
    expect(loads).toEqual(['chat', 'chat'])
    expect(changed).toEqual(['chat'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(loads).toHaveLength(2)
    expect(changed).toEqual(['chat'])
  })

  it('gives up after its last retry, until the next read', async () => {
    vi.useFakeTimers()
    const failing = Array.from({ length: 5 }, () => new Error('worker failed'))
    const { service, loads, changed } = imports(failing)
    service.start('chat')
    await vi.advanceTimersByTimeAsync(60_000)
    // The first try and one per delay.
    expect(loads).toHaveLength(3)
    expect(changed).toEqual([])
    service.start('chat')
    await vi.advanceTimersByTimeAsync(0)
    expect(loads).toHaveLength(4)
  })

  it('lets requests wait for a running import, not for a retry that waits', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const service = new ImportsBehindReads({
      load: () =>
        new Promise<boolean>((_, reject) => (finish = () => reject(new Error('worker failed')))),
      changed: () => undefined,
      retryDelaysMs: [100],
    })
    expect(service.settled(['chat'])).toBeUndefined()
    service.start('chat')
    let settled = false
    void service.settled(['other', 'chat'])!.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(service.settled(['chat'])).toBeUndefined()
  })

  it('starts no retry once closed', async () => {
    vi.useFakeTimers()
    const { service, loads } = imports([new Error('worker failed'), true])
    service.start('chat')
    await vi.advanceTimersByTimeAsync(0)
    service.close()
    await vi.advanceTimersByTimeAsync(10_000)
    service.start('chat')
    expect(loads).toEqual(['chat'])
  })
})
