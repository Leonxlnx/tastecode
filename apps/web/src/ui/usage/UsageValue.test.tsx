// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { historyResult, usageTotals } from './usage-history.fixture.js'
import { pricedShare, UsageValue } from './UsageValue.js'

afterEach(cleanup)

describe('usage page API value', () => {
  it('shows the API value at full strength when nearly every token is priced', () => {
    const result = historyResult('30d')
    result.totals = { ...result.totals, pricedTokens: 946_000, unpricedTokens: 50_000 }
    result.totals.processedTokens = 1_000_000
    result.totals.providerReportedTokens = 4_000
    render(<UsageValue data={result} />)

    const total = screen.getByText('$12.34')
    expect(total.hasAttribute('data-partial')).toBe(false)
    expect(screen.queryByText(/Partial estimate/)).toBeNull()
    expect(screen.getByText('$4.56')).toBeTruthy()
    expect(screen.getByText('82.6% of input was read from cache.')).toBeTruthy()
  })

  it('mutes the dollars and calls them a partial estimate under 95% priced tokens', () => {
    const result = historyResult('30d')
    result.totals = usageTotals({
      processedTokens: 1_000_000,
      pricedTokens: 6_000,
      providerReportedTokens: 4_000,
      unpricedTokens: 990_000,
      estimatedCostUsd: 12.34,
      cachedInputTokens: 10,
      uncachedInputTokens: 30,
    })
    render(<UsageValue data={result} />)

    expect(screen.getByText('$12.34').hasAttribute('data-partial')).toBe(true)
    expect(screen.getByText('Partial estimate · 1.0% of tokens priced')).toBeTruthy()
    expect(
      screen.getByText('25.0% of input was read from cache. Counts priced tokens only.'),
    ).toBeTruthy()
  })

  it('splits the value by provider only when there is more than one', () => {
    const result = historyResult('30d')
    render(<UsageValue data={result} />)
    expect(screen.queryByText('Codex')).toBeNull()
    cleanup()

    result.providers = [
      {
        provider: 'codex',
        sessionCount: 1,
        totals: usageTotals({ processedTokens: 10, estimatedCostUsd: 2 }),
      },
      {
        provider: 'grok',
        sessionCount: 1,
        totals: usageTotals({ processedTokens: 5, estimatedCostUsd: 1 }),
      },
      { provider: 'claude-code', sessionCount: 0, totals: usageTotals({}) },
    ]
    render(<UsageValue data={result} />)
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText('Grok')).toBeTruthy()
    expect(screen.queryByText('Claude Code')).toBeNull()
  })

  it('has no figure for a period without tokens', () => {
    const result = historyResult('7d')
    result.totals = usageTotals({})
    expect(pricedShare(result.totals)).toBeUndefined()
    render(<UsageValue data={result} />)
    expect(screen.getByText('No token records in this period.')).toBeTruthy()
  })
})
