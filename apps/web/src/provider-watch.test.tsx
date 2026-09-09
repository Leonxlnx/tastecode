// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from './test-transport.js'
import { useProviderWatch } from './provider-watch.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
describe('provider watch reader lease', () => {
  it('renews only the mounted viewer and stops when its project changes or closes', async () => {
    vi.useFakeTimers()
    const transport = new TestTransport(() => ({ expiresInMs: 60_000 }))
    const view = renderHook(({ path }) => useProviderWatch(transport, 'codex', path, 'skills'), {
      initialProps: { path: '/first' },
    })
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(transport.requests).toEqual([
      {
        method: 'providers.watch',
        params: { provider: 'codex', projectPath: '/first', targets: ['skills'] },
      },
    ])
    view.rerender({ path: '/second' })
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(transport.requests[1]?.params).toMatchObject({ projectPath: '/second' })
    transport.emitState('reconnecting')
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(transport.requests).toHaveLength(2)
    view.unmount()
    transport.emitState('open')
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(transport.requests).toHaveLength(2)
  })
})
