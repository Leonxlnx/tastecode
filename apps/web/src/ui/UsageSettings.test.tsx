// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UsageHistoryRange } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../transport.js'
import { ProfileSettings } from './ProfileSettings.js'
import { UsageSettings } from './UsageSettings.js'
import { historyResult } from './usage/usage-history.fixture.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function advance(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

describe('usage settings', () => {
  it('loads local history, changes period, and explicitly requests a rescan', async () => {
    const request = vi.fn(
      async (_method: string, params: { range: UsageHistoryRange; refresh?: boolean }) =>
        historyResult(params.range),
    )
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Usage' })).toBeTruthy()
    expect(screen.getByRole('status', { name: 'Reading the usage index' })).toBeTruthy()
    expect(await screen.findByText('4 sessions · Jul 10 to Aug 8, 2026')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Reading the usage index' })).toBeNull()
    expect(request).toHaveBeenNthCalledWith(1, 'usage.history', { range: '30d' })
    expect(screen.getByRole('radio', { name: '30 days' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: '7 days' }))
    await waitFor(() => {
      expect(request).toHaveBeenNthCalledWith(2, 'usage.history', { range: '7d' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Check for new usage' }))
    await waitFor(() => {
      expect(request).toHaveBeenNthCalledWith(3, 'usage.history', {
        range: '7d',
        refresh: true,
      })
    })
  })

  it('says how current the index is and where the numbers come from', async () => {
    const result = historyResult('30d')
    result.sources.push({ provider: 'grok', available: false, sessionCount: 0 })
    result.warnings = ['Some token records use models without a known public API price.']
    vi.useFakeTimers({ now: result.generatedAt + 5 * 60_000, toFake: ['Date'] })
    const transport = { request: vi.fn(async () => result) } as unknown as Transport
    render(<UsageSettings transport={transport} />)

    expect(await screen.findByText('Indexed 5m ago · 4 files · Codex')).toBeTruthy()
    expect(
      screen.getByText('Some token records use models without a known public API price.'),
    ).toBeTruthy()
  })

  it('keeps cached totals visible and checks a background scan again after 2 s', async () => {
    vi.useFakeTimers()
    let call = 0
    const request = vi.fn(async () => {
      const result = historyResult('30d')
      if (call === 0) result.scan = { status: 'scanning', filesProcessed: 10, filesTotal: 100 }
      call += 1
      return result
    })
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await advance(0)

    // A refresh of an existing index that is over by the next read is never
    // announced: the notice would only push the page down and back up.
    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
    expect(screen.getByText('4 sessions · Jul 10 to Aug 8, 2026')).toBeTruthy()
    await advance(1_999)
    expect(request).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
  })

  it('announces a refresh that a later read still finds running', async () => {
    vi.useFakeTimers()
    let call = 0
    const request = vi.fn(async () => {
      const result = historyResult('30d')
      call += 1
      if (call < 3) result.scan = { status: 'scanning', filesProcessed: call * 10, filesTotal: 100 }
      return result
    })
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
    await advance(2_000)
    expect(screen.getByText(/Indexing local usage · 20 of 100 files/)).toBeTruthy()
    await advance(3_000)
    expect(request).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
  })

  it('says at once that a first index is running', async () => {
    vi.useFakeTimers()
    const result = historyResult('30d')
    result.generatedAt = 0
    result.scan = { status: 'scanning', filesProcessed: 0, filesTotal: 0 }
    const transport = { request: vi.fn(async () => result) } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.getByText(/Indexing local usage · finding sessions/)).toBeTruthy()
  })

  it('keeps polling a background scan after a transient refresh failure', async () => {
    vi.useFakeTimers()
    let call = 0
    const request = vi.fn(async () => {
      const result = historyResult('30d')
      if (call === 0) {
        // A first index, which says so at once.
        result.generatedAt = 0
        result.scan = { status: 'scanning', filesProcessed: 10, filesTotal: 100 }
      } else if (call === 1) {
        call += 1
        throw new Error('Temporary connection failure')
      }
      call += 1
      return result
    })
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.getByText(/Indexing local usage/)).toBeTruthy()
    await advance(2_000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Temporary connection failure/)).toBeTruthy()
    await advance(3_000)
    expect(request).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(/Indexing local usage/)).toBeNull()
  })

  it('cancels a pending scan poll when the page unmounts', async () => {
    vi.useFakeTimers()
    const result = historyResult('30d')
    result.generatedAt = 0
    result.scan = { status: 'scanning', filesProcessed: 10, filesTotal: 100 }
    const request = vi.fn(async () => result)
    const transport = { request } as unknown as Transport
    const view = render(<UsageSettings transport={transport} />)
    await advance(0)

    expect(screen.getByText(/Indexing local usage/)).toBeTruthy()
    view.unmount()
    await advance(30_000)

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('offers another try when the first read fails', async () => {
    let fail = true
    const request = vi.fn(async (_method: string, params: { range: UsageHistoryRange }) => {
      if (fail) throw new Error('The index could not be opened.')
      return historyResult(params.range)
    })
    const transport = { request } as unknown as Transport
    render(<UsageSettings transport={transport} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The index could not be opened.')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('4 sessions · Jul 10 to Aug 8, 2026')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shares the all-time history with the profile page', async () => {
    const request = vi.fn(async (_method: string, params: { range: UsageHistoryRange }) =>
      historyResult(params.range),
    )
    const transport = { request } as unknown as Transport
    const view = render(<UsageSettings transport={transport} />)
    await screen.findByText('4 sessions · Jul 10 to Aug 8, 2026')
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    view.unmount()

    render(<ProfileSettings transport={transport} account={undefined} providerName="Codex" />)
    expect(await screen.findByRole('heading', { name: 'Local activity' })).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(2)
  })
})
