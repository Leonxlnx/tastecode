import { describe, expect, it } from 'vitest'
import { IDLE_THREAD_RUNTIME_MS, idleThreadRuntimeLimit } from './runtime-retention.js'

const GIBIBYTE = 1024 ** 3

describe('idle thread runtime limit', () => {
  it('keeps recently completed threads warm for five minutes', () => {
    expect(IDLE_THREAD_RUNTIME_MS).toBe(5 * 60_000)
  })

  it('keeps a small warm floor on low-memory machines', () => {
    expect(idleThreadRuntimeLimit(0)).toBe(4)
    expect(idleThreadRuntimeLimit(8 * GIBIBYTE)).toBe(4)
  })

  it('scales with available hardware', () => {
    expect(idleThreadRuntimeLimit(16 * GIBIBYTE)).toBe(8)
    expect(idleThreadRuntimeLimit(24 * GIBIBYTE)).toBe(12)
  })

  it('bounds idle child processes on large machines', () => {
    expect(idleThreadRuntimeLimit(32 * GIBIBYTE)).toBe(16)
    expect(idleThreadRuntimeLimit(128 * GIBIBYTE)).toBe(16)
  })
})
