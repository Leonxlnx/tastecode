// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ProviderId } from '@harness/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { historyResult, usageTotals } from './usage-history.fixture.js'
import { UsageModels } from './UsageModels.js'

afterEach(cleanup)

describe('usage page models', () => {
  it('lists models by tokens with their share and value', () => {
    const result = historyResult('30d')
    result.totals.processedTokens = 2_000_000
    result.models = [
      model('codex', 'gpt-5.6-sol', 'exact', 500_000, 5),
      model('claude-code', 'claude-opus-5-5', 'exact', 1_500_000, 50),
    ]
    render(<UsageModels data={result} />)

    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.querySelector('.usage-models__model')?.textContent)).toEqual([
      'claude-opus-5-5',
      'gpt-5.6-sol',
    ])
    expect(rows[0]?.textContent).toContain('1.5M')
    expect(rows[0]?.textContent).toContain('75.0%')
    expect(rows[0]?.textContent).toContain('$50.00')
    expect(within(rows[0] as HTMLElement).getByRole('rowheader').textContent).toContain(
      'Claude Code',
    )
  })

  it('marks approximate and unpriced models and has no value for the unpriced', () => {
    const result = historyResult('30d')
    result.models = [
      model('claude-code', 'claude-haiku-5-5', 'family', 1_000, 1),
      model('codex', 'codex-auto-review', 'unpriced', 500, 0),
    ]
    render(<UsageModels data={result} />)

    const approximate = screen.getByText('approximate')
    expect(approximate.closest('tr')?.textContent).toContain('claude-haiku-5-5')
    const unpriced = screen.getByText('unpriced').closest('tr')
    expect(unpriced?.lastElementChild?.textContent).toBe('—')
  })

  it('shows the first eight models until asked for all', () => {
    const result = historyResult('30d')
    result.models = Array.from({ length: 11 }, (_, index) =>
      model('codex', `model-${index}`, 'exact', 1_000 - index, 1),
    )
    render(<UsageModels data={result} />)

    expect(screen.getAllByRole('row')).toHaveLength(9)
    const more = screen.getByRole('button', { name: 'Show all 11 models' })
    fireEvent.click(more)
    expect(screen.getAllByRole('row')).toHaveLength(12)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(more.textContent).toBe('Show fewer')
  })
})

function model(
  provider: ProviderId,
  name: string,
  pricing: 'exact' | 'family' | 'unpriced',
  tokens: number,
  cost: number,
) {
  return {
    provider,
    model: name,
    sessionCount: 1,
    pricing,
    totals: usageTotals({
      processedTokens: tokens,
      estimatedCostUsd: cost,
      pricedTokens: pricing === 'unpriced' ? 0 : tokens,
      unpricedTokens: pricing === 'unpriced' ? tokens : 0,
    }),
  }
}
