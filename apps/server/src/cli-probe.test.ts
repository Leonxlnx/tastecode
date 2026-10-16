import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliProbe, type CliProbeSystem } from './cli-probe.js'

afterEach(() => vi.useRealTimers())

/** A machine with one CLI whose version answer the test controls. */
function machine() {
  const answers: Array<(version: string | undefined) => void> = []
  const state = { installed: true, stamp: 'v1' }
  const system = {
    locate: vi.fn(async (command: string) => (state.installed ? `/bin/${command}` : undefined)),
    stamp: vi.fn(async () => state.stamp),
    version: vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          answers.push(resolve)
        }),
    ),
  } satisfies CliProbeSystem
  const answer = async (version: string | undefined) => {
    answers.shift()?.(version)
    await vi.advanceTimersByTimeAsync(0)
  }
  return { state, system, answer, probe: new CliProbe(system) }
}

describe('CLI probe', () => {
  it('starts one version read for concurrent callers', async () => {
    vi.useFakeTimers()
    const { system, answer, probe } = machine()
    const first = probe.version('codex')
    const second = probe.version('codex')
    await vi.advanceTimersByTimeAsync(0)
    await answer('codex-cli 1.4.0')
    await expect(Promise.all([first, second])).resolves.toEqual([
      'codex-cli 1.4.0',
      'codex-cli 1.4.0',
    ])
    expect(system.version).toHaveBeenCalledTimes(1)
  })

  it('answers a later caller from the kept version without starting the CLI', async () => {
    vi.useFakeTimers()
    const { system, answer, probe } = machine()
    const first = probe.version('codex')
    await vi.advanceTimersByTimeAsync(0)
    await answer('codex-cli 1.4.0')
    await first
    await expect(probe.version('codex')).resolves.toBe('codex-cli 1.4.0')
    expect(system.version).toHaveBeenCalledTimes(1)
  })

  it('returns without a version after the wait and keeps the late answer', async () => {
    vi.useFakeTimers()
    const { system, answer, probe } = machine()
    const scan = probe.version('cursor-agent', { waitMs: 250 })
    await vi.advanceTimersByTimeAsync(250)
    await expect(scan).resolves.toBeUndefined()
    await answer('2026.07.23')
    await expect(probe.version('cursor-agent', { waitMs: 250 })).resolves.toBe('2026.07.23')
    expect(system.version).toHaveBeenCalledTimes(1)
  })

  it('reads again when the binary was replaced', async () => {
    vi.useFakeTimers()
    const { state, system, answer, probe } = machine()
    const first = probe.version('agy')
    await vi.advanceTimersByTimeAsync(0)
    await answer('1.3.4')
    await first
    state.stamp = 'v2'
    const second = probe.version('agy')
    await vi.advanceTimersByTimeAsync(0)
    await answer('1.4.0')
    await expect(second).resolves.toBe('1.4.0')
    expect(system.version).toHaveBeenCalledTimes(2)
  })

  it('serves an old answer for the same binary while it is refreshed', async () => {
    vi.useFakeTimers()
    const { system, answer, probe } = machine()
    const first = probe.version('grok')
    await vi.advanceTimersByTimeAsync(0)
    await answer('grok 1.0.60')
    await first
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
    await expect(probe.version('grok')).resolves.toBe('grok 1.0.60')
    expect(system.version).toHaveBeenCalledTimes(2)
    await answer('grok 1.0.61')
    await expect(probe.version('grok')).resolves.toBe('grok 1.0.61')
  })

  it('asks a CLI that would not say its version again after a minute', async () => {
    vi.useFakeTimers()
    const { system, answer, probe } = machine()
    const first = probe.version('opencode')
    await vi.advanceTimersByTimeAsync(0)
    await answer(undefined)
    await first
    await probe.version('opencode', { waitMs: 0 })
    expect(system.version).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_001)
    void probe.version('opencode', { waitMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(system.version).toHaveBeenCalledTimes(2)
  })

  it('does not let a read that began before an invalidation answer after it', async () => {
    vi.useFakeTimers()
    const { system, answer, probe } = machine()
    const before = probe.version('claude')
    await vi.advanceTimersByTimeAsync(0)
    probe.invalidate()
    const after = probe.version('claude')
    await vi.advanceTimersByTimeAsync(0)
    expect(system.version).toHaveBeenCalledTimes(2)
    await answer('2.1.0')
    await answer('2.2.0')
    await expect(before).resolves.toBe('2.1.0')
    await expect(after).resolves.toBe('2.2.0')
    await expect(probe.version('claude')).resolves.toBe('2.2.0')
  })

  it('reads afresh for a caller verifying an update', async () => {
    vi.useFakeTimers()
    const { system, answer, probe } = machine()
    const first = probe.version('codex')
    await vi.advanceTimersByTimeAsync(0)
    await answer('codex-cli 0.9.0')
    await first
    const verified = probe.version('codex', { fresh: true })
    await vi.advanceTimersByTimeAsync(0)
    await answer('codex-cli 0.11.0')
    await expect(verified).resolves.toBe('codex-cli 0.11.0')
    expect(system.version).toHaveBeenCalledTimes(2)
  })

  it('reports a missing CLI without starting anything', async () => {
    const { state, system, probe } = machine()
    state.installed = false
    await expect(probe.installed('pi')).resolves.toBe(false)
    await expect(probe.version('pi')).resolves.toBeUndefined()
    expect(system.version).not.toHaveBeenCalled()
  })
})
