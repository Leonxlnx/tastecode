import { describe, expect, it } from 'vitest'
import { IDLE_THREAD_RUNTIME_MS, idleThreadRuntimeLimit } from './runtime-retention.js'

const GIBIBYTE = 1024 ** 3

describe('idle thread runtime limit', () => {
  it('keeps recently completed threads warm for two minutes', () => {
    expect(IDLE_THREAD_RUNTIME_MS).toBe(2 * 60_000)
  })

  it('keeps a small warm floor on low-memory machines', () => {
    expect(idleThreadRuntimeLimit(0)).toBe(2)
    expect(idleThreadRuntimeLimit(8 * GIBIBYTE)).toBe(2)
    expect(idleThreadRuntimeLimit(16 * GIBIBYTE)).toBe(2)
  })

  it('scales with available hardware, one warm agent per 8 GiB', () => {
    expect(idleThreadRuntimeLimit(32 * GIBIBYTE)).toBe(4)
    expect(idleThreadRuntimeLimit(40 * GIBIBYTE)).toBe(5)
  })

  it('bounds idle child processes on large machines', () => {
    expect(idleThreadRuntimeLimit(64 * GIBIBYTE)).toBe(6)
    expect(idleThreadRuntimeLimit(128 * GIBIBYTE)).toBe(6)
  })
})
