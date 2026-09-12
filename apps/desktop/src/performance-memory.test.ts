import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseMacFootprint,
  sampleSettledMemory,
  type BenchmarkMemory,
} from './performance-memory.js'

const metrics = [
  { pid: 11, type: 'Browser', memory: { workingSetSize: 100, peakWorkingSetSize: 100 } },
  { pid: 12, type: 'GPU', memory: { workingSetSize: 200, peakWorkingSetSize: 200 } },
  { pid: 13, type: 'Utility', memory: { workingSetSize: 300, peakWorkingSetSize: 300 } },
  { pid: 14, type: 'Tab', memory: { workingSetSize: 400, peakWorkingSetSize: 400 } },
]

afterEach(() => vi.useRealTimers())

function measured(bytes: number, pid = 11): BenchmarkMemory {
  return {
    metric: 'working-set',
    bytes,
    rssBytes: bytes,
    processes: [{ pid, type: 'Browser', bytes, rssBytes: bytes, source: 'working-set' }],
  }
}

describe('whole-app benchmark memory', () => {
  it('counts every process footprint and retains the summed RSS', () => {
    const result = parseMacFootprint(
      {
        'bytes per unit': 1,
        processes: metrics.map((entry) => ({ pid: entry.pid, footprint: entry.pid * 1000 })),
      },
      metrics,
    )
    expect(result.metric).toBe('macos-physical-footprint')
    expect(result.bytes).toBe(50_000)
    expect(result.rssBytes).toBe(1_024_000)
    expect(result.processes.map((entry) => entry.type)).toEqual([
      'Browser',
      'GPU',
      'Utility',
      'Tab',
    ])
  })

  it('uses full RSS for every missing, zero, malformed or duplicate process', () => {
    const result = parseMacFootprint(
      {
        'bytes per unit': 1,
        processes: [
          { pid: 11, footprint: 10_000 },
          { pid: 12, footprint: 0 },
          { pid: 13, footprint: 10 },
          { pid: 13, footprint: 20 },
        ],
      },
      metrics,
    )
    expect(result.metric).toBe('mixed-conservative')
    expect(result.bytes).toBe(10_000 + 900 * 1024)
    expect(result.processes).toHaveLength(4)
  })

  it('cannot pass by omitting all processes or using unrecognized units', () => {
    expect(parseMacFootprint({}, []).bytes).toBeNaN()
    expect(
      parseMacFootprint({ 'bytes per unit': 1024, processes: [{ pid: 11, footprint: 1 }] }, metrics)
        .bytes,
    ).toBe(1_024_000)
  })

  it('waits for four stable samples and keeps the earlier allocation peak', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let index = 0
    const values = [600_000_000, 300_000_000, 303_000_000, 301_000_000, 302_000_000]
    const result = sampleSettledMemory(async () => measured(values[index++]!))
    await vi.advanceTimersByTimeAsync(4_000)
    const memory = await result
    expect(memory.stable).toBe(true)
    expect(memory.samples).toHaveLength(5)
    expect(memory.stableWindow).toHaveLength(4)
    expect(memory.bytes).toBe(303_000_000)
    expect(memory.peakBytes).toBe(600_000_000)
    expect(memory.stableWindow[3]!.elapsedMs).toBe(4_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a drift across the complete window even if adjacent changes are below 2 percent', async () => {
    vi.useFakeTimers()
    let index = 0
    const result = sampleSettledMemory(async () => measured(100_000_000 + index++ * 1_500_000))
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await result).stable).toBe(false)
    expect((await result).samples).toHaveLength(10)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never reports stability while owned processes are being replaced', async () => {
    vi.useFakeTimers()
    let pid = 1
    const result = sampleSettledMemory(async () => measured(100_000_000, pid++))
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await result).stable).toBe(false)
  })

  it('cancels a hung measurement at the ten-second deadline', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const result = sampleSettledMemory((captureSignal) => {
      signal = captureSignal
      return new Promise(() => undefined)
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(signal?.aborted).toBe(true)
    expect((await result).stable).toBe(false)
    expect((await result).bytes).toBeNaN()
    expect(vi.getTimerCount()).toBe(0)
  })
})
