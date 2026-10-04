// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResultOf, UsageHistoryTotals } from '@harness/contracts'
import type { Transport } from '../transport.js'
import { GeneratedAvatar } from './GeneratedAvatar.js'
import { ProfileSettings } from './ProfileSettings.js'

const transport = { request: () => new Promise(() => {}) } as unknown as Transport

afterEach(cleanup)

function renderedAvatarCells(): string {
  return document.querySelector('.profile-identity__avatar svg')!.innerHTML
}

/** What the picture for `name` looks like when rendered on its own. */
function expectedAvatarCells(name: string): string {
  const view = render(<GeneratedAvatar name={name} />)
  const markup = view.container.querySelector('svg')!.innerHTML
  view.unmount()
  return markup
}

describe('profile settings', () => {
  it('keeps the identity editor mounted when local activity finishes loading', async () => {
    let finishHistory: (result: ResultOf<'usage.history'>) => void = () => {}
    const request = vi.fn(
      () => new Promise<ResultOf<'usage.history'>>((resolve) => (finishHistory = resolve)),
    )
    render(
      <ProfileSettings
        transport={{ request } as unknown as Transport}
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Leon' }}
      />,
    )
    const editor = screen.getByRole('textbox', { name: 'Display name' })
    editor.focus()

    finishHistory(historyResult())

    await screen.findByText('1.2M')
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBe(editor)
    expect(document.activeElement).toBe(editor)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('builds the profile from real local history and explicitly refreshes it', async () => {
    const result = historyResult()
    const request = vi.fn(async () => result)
    const transport = { request } as unknown as Transport

    render(
      <ProfileSettings
        transport={transport}
        account={{ signedIn: true, email: 'blue.emi@example.com', plan: 'Pro' }}
        providerName="Codex"
      />,
    )

    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Local profile' })).toBeTruthy()
    expect(renderedAvatarCells()).toBe(expectedAvatarCells('Local profile'))
    expect(screen.queryByText('@blue.emi')).toBeNull()
    expect(screen.getByText('Pro')).toBeTruthy()
    expect(await screen.findByText('1.2M')).toBeTruthy()
    expect(screen.getByText('7', { selector: '.profile-stats dd' })).toBeTruthy()
    expect(screen.getAllByText('3 days')).toHaveLength(2)
    expect(screen.getByText('75%')).toBeTruthy()
    expect(screen.getAllByText('gpt-5.6-sol').length).toBeGreaterThan(0)
    const topProvider = screen.getByText('Top provider').closest('div')
    expect(topProvider?.querySelector('.source-identity')?.getAttribute('title')).toBe('Codex')
    const topModel = document.querySelector('.profile-models li')
    expect(topModel?.querySelector('.source-identity')?.getAttribute('title')).toBe(
      'Codex · gpt-5.6-sol',
    )
    const activityCell = document.querySelector<HTMLElement>('[data-activity-date="2026-08-08"]')
    expect(activityCell).not.toBeNull()
    fireEvent.pointerEnter(activityCell!)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip.textContent).toContain('400 tokens on Aug 8')
    expect(tooltip.textContent).toContain('Usage by provider')
    expect(tooltip.textContent).toContain('Codex')
    expect(tooltip.textContent).toContain('250')
    expect(tooltip.textContent).toContain('63%')
    expect(tooltip.textContent).toContain('Claude Code')
    expect(tooltip.textContent).toContain('150')
    expect(tooltip.textContent).toContain('38%')
    expect(tooltip.querySelectorAll('.source-identity--compact')).toHaveLength(2)
    fireEvent.pointerLeave(activityCell!)
    expect(screen.queryByRole('tooltip')).toBeNull()

    const emptyCell = document.querySelector<HTMLElement>('[data-activity-date="2026-08-05"]')
    expect(emptyCell).not.toBeNull()
    fireEvent.pointerEnter(emptyCell!)
    expect(screen.getByRole('tooltip').textContent).toContain('No token records for this day.')
    fireEvent.pointerLeave(emptyCell!)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(request).toHaveBeenNthCalledWith(1, 'usage.history', { range: 'all' })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh profile activity' }))
    await waitFor(() => {
      expect(request).toHaveBeenNthCalledWith(2, 'usage.history', {
        range: 'all',
        refresh: true,
      })
    })
  })

  it('shows an actionable error when no cached profile can be loaded', async () => {
    const request = vi.fn(async () => {
      throw new Error('History unavailable')
    })
    const transport = { request } as unknown as Transport

    render(<ProfileSettings transport={transport} account={undefined} providerName="Claude Code" />)

    expect((await screen.findByRole('alert')).textContent).toContain('History unavailable')
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  })

  it('continues polling after a transient profile scan failure', async () => {
    let call = 0
    const request = vi.fn(async () => {
      call += 1
      if (call === 1) {
        const result = historyResult()
        result.scan = { status: 'scanning', filesProcessed: 3, filesTotal: 7 }
        return result
      }
      if (call === 2) throw new Error('Temporary history failure')
      return historyResult()
    })
    const transport = { request } as unknown as Transport

    render(<ProfileSettings transport={transport} account={undefined} providerName="Codex" />)

    expect(await screen.findByText(/Indexing local activity/)).toBeTruthy()
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3), { timeout: 1_600 })
    await waitFor(() => {
      expect(screen.queryByText(/Indexing local activity/)).toBeNull()
    })
  })

  it('reserves the plan line while the account loads and fills the same slot', () => {
    const view = render(
      <ProfileSettings
        transport={transport}
        account={undefined}
        accountLoading
        providerName="Codex"
      />,
    )
    const loading = screen.getByText('Loading account plan…').closest('[role="status"]')!
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.classList.contains('profile-identity__meta')).toBe(true)
    expect(screen.getByText('Loading account plan…').className).toBe('visually-hidden')
    expect(loading.querySelector('.skeleton')?.getAttribute('style')).toContain('height: 9px')
    expect(screen.queryByText('Pro')).toBeNull()
    const editor = screen.getByRole('textbox', { name: 'Display name' })

    view.rerender(
      <ProfileSettings
        transport={transport}
        account={{ signedIn: true, plan: 'Pro' }}
        providerName="Codex"
      />,
    )
    expect(screen.queryByText('Loading account plan…')).toBeNull()
    expect(screen.getByText('Pro').closest('.profile-identity__meta')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBe(editor)
  })

  it('does not reserve an unknown plan without an active account request', () => {
    const view = render(
      <ProfileSettings transport={transport} account={undefined} providerName="Codex" />,
    )
    expect(view.container.querySelector('.profile-identity__meta')).toBeNull()
    view.rerender(
      <ProfileSettings
        transport={transport}
        account={undefined}
        accountLoading
        providerName="Codex"
      />,
    )
    expect(screen.getByText('Loading account plan…')).toBeTruthy()
    view.rerender(
      <ProfileSettings transport={transport} account={{ signedIn: false }} providerName="Codex" />,
    )
    expect(view.container.querySelector('.profile-identity__meta')).toBeNull()
  })

  it('keeps an already known plan visible during account refresh', () => {
    render(
      <ProfileSettings
        transport={transport}
        account={{ signedIn: true, plan: 'Pro' }}
        accountLoading
        providerName="Codex"
      />,
    )
    expect(screen.getByText('Pro')).toBeTruthy()
    expect(screen.queryByText('Loading account plan…')).toBeNull()
  })

  it('keeps the onboarding name when switching to Grok', () => {
    const view = render(
      <ProfileSettings
        transport={transport}
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Blue Emi' }}
      />,
    )
    view.rerender(
      <ProfileSettings
        transport={transport}
        account={undefined}
        providerName="Grok"
        identity={{ displayName: 'Blue Emi' }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Blue Emi' })).toBeTruthy()
    expect(renderedAvatarCells()).toBe(expectedAvatarCells('Blue Emi'))
    expect(screen.queryByText('Grok')).toBeNull()
  })

  it('shows the local identity while usage history loads', () => {
    render(
      <ProfileSettings
        transport={transport}
        account={{ signedIn: true, email: 'blue.emi@example.com', plan: 'Pro' }}
        providerName="Codex"
      />,
    )

    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Local profile' })).toBeTruthy()
    expect(renderedAvatarCells()).toBe(expectedAvatarCells('Local profile'))
    expect(screen.getByText(/Generated from your name/u)).toBeTruthy()
    expect(screen.queryByText('@blue.emi')).toBeNull()
    expect(screen.getByText('Pro')).toBeTruthy()
  })

  it('regenerates the picture from the name until a photo replaces it', () => {
    const view = render(
      <ProfileSettings
        transport={transport}
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Leon' }}
      />,
    )
    const leon = renderedAvatarCells()
    expect(leon).toBe(expectedAvatarCells('Leon'))

    view.rerender(
      <ProfileSettings
        transport={transport}
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Bluedev' }}
      />,
    )
    expect(renderedAvatarCells()).toBe(expectedAvatarCells('Bluedev'))
    expect(renderedAvatarCells()).not.toBe(leon)

    view.rerender(
      <ProfileSettings
        transport={transport}
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Bluedev', avatarDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }}
      />,
    )
    expect(document.querySelector('.profile-identity__avatar svg')).toBeNull()
    expect(document.querySelector('.profile-identity__avatar img')).toBeTruthy()
    expect(screen.getByText(/Remove the photo to go back/u)).toBeTruthy()
  })

  it('edits the local display name and validates profile photos', async () => {
    const onIdentityChange = vi.fn()
    const { rerender } = render(
      <ProfileSettings
        transport={transport}
        account={undefined}
        providerName="Codex"
        identity={{ displayName: '' }}
        onIdentityChange={onIdentityChange}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Leon' },
    })
    expect(onIdentityChange).toHaveBeenLastCalledWith({ displayName: 'Leon' })

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.closest('.profile-identity__portrait')).toBeTruthy()
    expect(input.closest('label')?.textContent).toBe('Upload photo')
    expect(screen.queryByRole('button', { name: 'Remove photo' })).toBeNull()
    fireEvent.change(input, {
      target: {
        files: [
          new File(
            [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
            'avatar.png',
            { type: 'image/png' },
          ),
        ],
      },
    })
    await waitFor(() =>
      expect(onIdentityChange).toHaveBeenLastCalledWith({
        avatarDataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
      }),
    )
    fireEvent.change(input, {
      target: { files: [new File(['nope'], 'avatar.png', { type: 'image/png' })] },
    })
    expect((await screen.findByRole('alert')).textContent).toContain('not a valid image')

    const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgo='
    rerender(
      <ProfileSettings
        transport={transport}
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Leon', avatarDataUrl }}
        onIdentityChange={onIdentityChange}
      />,
    )
    expect(document.querySelector('.profile-identity__avatar img')?.getAttribute('src')).toBe(
      avatarDataUrl,
    )
    expect(input.closest('label')?.textContent).toBe('Change photo')
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarDataUrl: undefined })
  })

  it('ignores an image read that finishes after the profile closes', async () => {
    let finishRead: (value: ArrayBuffer) => void = () => {}
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' })
    const slicedFile = new Blob()
    vi.spyOn(slicedFile, 'arrayBuffer').mockImplementation(
      () => new Promise((resolve) => (finishRead = resolve)),
    )
    vi.spyOn(file, 'slice').mockReturnValue(slicedFile)
    const onIdentityChange = vi.fn()
    const view = render(
      <ProfileSettings
        transport={transport}
        account={undefined}
        providerName="Codex"
        identity={{ displayName: 'Leon' }}
        onIdentityChange={onIdentityChange}
      />,
    )
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    })
    view.unmount()
    finishRead(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onIdentityChange).not.toHaveBeenCalled()
  })
})

function historyResult(): ResultOf<'usage.history'> {
  const totals = usageTotals({
    uncachedInputTokens: 250_000,
    cachedInputTokens: 750_000,
    outputTokens: 150_000,
    reasoningTokens: 50_000,
    processedTokens: 1_200_000,
    estimatedCostUsd: 18,
    cacheSavingsUsd: 6,
    pricedTokens: 1_200_000,
  })
  const dailyTokens = [100, 0, 200, 300, 400, 0]
  const dailyProviders = [
    [{ provider: 'codex' as const, tokens: 100, estimatedCostUsd: 1 }],
    [],
    [{ provider: 'codex' as const, tokens: 200, estimatedCostUsd: 2 }],
    [{ provider: 'codex' as const, tokens: 300, estimatedCostUsd: 3 }],
    [
      { provider: 'codex' as const, tokens: 250, estimatedCostUsd: 2.5 },
      { provider: 'claude-code' as const, tokens: 150, estimatedCostUsd: 1.5 },
    ],
    [],
  ]
  const daily = dailyTokens.map((tokens, index) => ({
    date: `2026-08-0${index + 4}`,
    sessionCount: tokens > 0 ? 1 : 0,
    totals: usageTotals({ processedTokens: tokens }),
    providers: dailyProviders[index] ?? [],
  }))

  return {
    range: 'all',
    startDate: '2026-08-04',
    endDate: '2026-08-09',
    generatedAt: 1,
    sessionCount: 7,
    activeDays: 4,
    totals,
    providers: [
      { provider: 'codex', sessionCount: 6, totals },
      {
        provider: 'claude-code',
        sessionCount: 1,
        totals: usageTotals({ processedTokens: 100_000 }),
      },
    ],
    models: [
      {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        sessionCount: 6,
        pricing: 'exact',
        totals: usageTotals({ processedTokens: 900_000 }),
      },
      {
        provider: 'claude-code',
        model: 'claude-opus-4-8',
        sessionCount: 1,
        pricing: 'exact',
        totals: usageTotals({ processedTokens: 300_000 }),
      },
    ],
    daily,
    sources: [{ provider: 'codex', available: true, sessionCount: 7 }],
    scan: { status: 'idle', filesProcessed: 7, filesTotal: 7 },
    warnings: [],
  }
}

function usageTotals(values: Partial<UsageHistoryTotals>): UsageHistoryTotals {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    processedTokens: 0,
    estimatedCostUsd: 0,
    cacheSavingsUsd: 0,
    providerReportedCostUsd: 0,
    providerReportedTokens: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    ...values,
  }
}
