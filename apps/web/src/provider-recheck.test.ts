// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ProviderStatus } from '@harness/contracts'
import { TestTransport } from './test-transport.js'
import {
  PROVIDER_RECHECK_INTERVAL_MS,
  providerScanChanged,
  useInstallCheck,
  useRecheckOnFocus,
} from './provider-recheck.js'

afterEach(() => vi.useRealTimers())

const cursor = (installed: boolean, extra: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: 'cursor',
  displayName: 'Cursor',
  installed,
  auth: 'unknown',
  ...extra,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('provider scan comparison', () => {
  it('ignores a version the scan only learned now', () => {
    expect(providerScanChanged([cursor(true)], [cursor(true, { version: '2026.10.02' })])).toBe(
      false,
    )
  })

  it('reports a CLI that appeared, a sign-in and a problem', () => {
    expect(providerScanChanged([cursor(false)], [cursor(true)])).toBe(true)
    expect(providerScanChanged([cursor(true)], [cursor(true, { auth: 'authenticated' })])).toBe(
      true,
    )
    expect(providerScanChanged([cursor(true)], [cursor(true, { problem: 'Broken' })])).toBe(true)
  })
})

describe('re-check on window focus', () => {
  it('waits out the interval from mount and between checks', () => {
    vi.useFakeTimers()
    const recheck = vi.fn()
    renderHook(() => useRecheckOnFocus(true, recheck))
    const focus = () => act(() => window.dispatchEvent(new Event('focus')))

    focus()
    expect(recheck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PROVIDER_RECHECK_INTERVAL_MS)
    focus()
    focus()
    expect(recheck).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PROVIDER_RECHECK_INTERVAL_MS)
    focus()
    expect(recheck).toHaveBeenCalledTimes(2)
  })

  it('does nothing while nothing is missing, and always calls the latest callback', () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ needed, recheck }) => useRecheckOnFocus(needed, recheck), {
      initialProps: { needed: false, recheck: first },
    })
    vi.advanceTimersByTime(PROVIDER_RECHECK_INTERVAL_MS)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(first).not.toHaveBeenCalled()

    rerender({ needed: true, recheck: second })
    act(() => window.dispatchEvent(new Event('focus')))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('check again', () => {
  it('leaves the catalog alone when the provider is still missing', async () => {
    const answer = deferred<{ providers: ProviderStatus[] }>()
    const transport = new TestTransport(() => answer.promise)
    const onFound = vi.fn()
    const { result } = renderHook(() => useInstallCheck(transport, { provider: 'cursor' }, onFound))

    act(() => result.current.check())
    expect(result.current.checking).toBe(true)
    act(() => result.current.check())
    await act(async () => answer.resolve({ providers: [cursor(false)] }))

    expect(result.current.checking).toBe(false)
    expect(onFound).not.toHaveBeenCalled()
    expect(transport.requests).toEqual([{ method: 'providers.list', params: {} }])
  })

  it('reloads once when the provider is there now and keeps checking until replaced', async () => {
    const transport = new TestTransport(() => ({ providers: [cursor(true)] }))
    const onFound = vi.fn()
    const { result } = renderHook(() => useInstallCheck(transport, { provider: 'cursor' }, onFound))

    await act(async () => result.current.check())

    expect(onFound).toHaveBeenCalledTimes(1)
    expect(result.current.checking).toBe(true)
  })

  it('looks an ACP agent up in the agent list', async () => {
    const transport = new TestTransport(() => ({
      agents: [
        {
          id: 'kimi',
          name: 'Kimi',
          installed: true,
          verified: true,
          setup: { installUrl: 'https://example.test/kimi', login: 'provider' },
        },
      ],
    }))
    const onFound = vi.fn()
    const { result } = renderHook(() =>
      useInstallCheck(transport, { provider: 'acp', agent: 'kimi' }, onFound),
    )

    await act(async () => result.current.check())

    expect(transport.requests.map((request) => request.method)).toEqual(['acp.agents'])
    expect(onFound).toHaveBeenCalledTimes(1)
  })

  it('treats a failed check as not found', async () => {
    const transport = new TestTransport(() => {
      throw new Error('server restarting')
    })
    const onFound = vi.fn()
    const { result } = renderHook(() => useInstallCheck(transport, { provider: 'cursor' }, onFound))

    await act(async () => result.current.check())

    expect(result.current.checking).toBe(false)
    expect(onFound).not.toHaveBeenCalled()
  })
})
