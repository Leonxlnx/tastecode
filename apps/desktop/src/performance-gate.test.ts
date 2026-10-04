import { describe, expect, it } from 'vitest'
import { performanceFailures } from '../scripts/performance/budgets.js'

const goodMemory = () => ({
  stable: true,
  stableWindow: Array.from({ length: 4 }, () => ({ bytes: 200_000_000 })),
})
const goodSample = () => ({
  firstPaintMs: 100,
  initiallyVisible: 5,
  sessions: 5,
  memoryBytes: 200_000_000,
  memory: goodMemory(),
  scroll: { seenMessages: 500, frames: Array(120).fill(16.67) },
  streaming: { deltas: 1920, batches: Array(120).fill(2), frames: Array(120).fill(16.67) },
  switches: Array(5).fill(50),
  highlighting: {
    codeCharacters: 48_000,
    coldRequests: 1,
    remountRequests: 0,
    themeRequests: 0,
    coloredTokens: 100,
    colors: ['rgb(1, 2, 3)', 'rgb(4, 5, 6)'],
    frames: Array(12).fill(16.67),
    longTasks: [] as number[],
    trace: { maxMainTaskMs: 16, mainTaskCount: 10, workerThreads: 1 },
  },
})
const startups = () =>
  Array.from({ length: 3 }, () => ({
    interactive: 1000,
    settled: { memory: goodMemory() },
  }))

describe('real Electron performance gates', () => {
  it('requires repeated rendered evidence before passing', () => {
    expect(performanceFailures([], [])).not.toEqual([])
    const samples = Array.from({ length: 3 }, goodSample)
    expect(performanceFailures(samples, startups())).toEqual([])
    samples[0]!.initiallyVisible = 0
    expect(performanceFailures(samples, startups())).toContain(
      'renderer 1: missing rendered fixture coverage',
    )
  })

  it('fails every documented budget instead of only printing measurements', () => {
    const samples = Array.from({ length: 3 }, goodSample)
    const startup = startups()
    samples[1]!.firstPaintMs = 150
    samples[1]!.scroll.frames[0] = 33
    samples[1]!.streaming.frames[0] = 34
    samples[1]!.streaming.batches[0] = 4
    samples[1]!.switches[0] = 100
    samples[1]!.memory.stableWindow[0]!.bytes = 500_000_000
    startup[1]!.interactive = 1500
    expect(performanceFailures(samples, startup)).toHaveLength(7)
  })

  it('rejects an empty virtualizer and incomplete message traversal', () => {
    const samples = Array.from({ length: 3 }, goodSample)
    samples[2]!.scroll.seenMessages = 499
    expect(performanceFailures(samples, startups())).toContain(
      'renderer 3: missing rendered fixture coverage',
    )
  })

  it('refuses an unsettled measurement even when its last value is small', () => {
    const samples = Array.from({ length: 3 }, goodSample)
    samples[0]!.memory.stable = false
    expect(performanceFailures(samples, startups())).toContain(
      'renderer 1: memory did not settle within ten seconds',
    )
  })

  it('requires real highlighting, cache reuse, and distinct painted theme colors', () => {
    for (const change of [
      { coldRequests: 0 },
      { coldRequests: 2 },
      { remountRequests: 1 },
      { themeRequests: 1 },
      { coloredTokens: 0 },
      { colors: ['same', 'same'] },
      { frames: [] },
    ]) {
      const samples = Array.from({ length: 3 }, goodSample)
      Object.assign(samples[0]!.highlighting, change)
      expect(performanceFailures(samples, startups())).toContain(
        'renderer 1: missing real-worker highlighting or cache/theme coverage',
      )
    }
  })

  it('fails slow real-worker frames and observed long tasks', () => {
    const samples = Array.from({ length: 3 }, goodSample)
    samples[0]!.highlighting.frames[0] = 33
    samples[0]!.highlighting.longTasks.push(60)
    expect(performanceFailures(samples, startups())).toEqual([
      'renderer 1 worst highlighting frame ms: 33 (must be < 32)',
      'renderer 1 worst highlighting long task ms: 60 (must be < 32)',
    ])
  })

  it('fails a 32 ms trace task even when frame samples and the 50 ms observer pass', () => {
    const samples = Array.from({ length: 3 }, goodSample)
    samples[0]!.highlighting.trace.maxMainTaskMs = 32
    expect(performanceFailures(samples, startups())).toEqual([
      'renderer 1 worst highlighting trace task ms: 32 (must be < 32)',
    ])
  })
})
