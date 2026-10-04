// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { ResultOf, UsageHistoryTotals } from '@harness/contracts'
import type { Transport } from '../transport.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CELL, generatedAvatar } from '../generated-avatar.js'
import { STRIKE_DELAY_MS } from './ProfileCoin.js'
import { ProfileSettings } from './ProfileSettings.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const pendingTransport = { request: () => new Promise(() => {}) } as unknown as Transport

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PHOTO = 'data:image/png;base64,iVBORw0KGgo='

type Props = ComponentProps<typeof ProfileSettings>

function renderProfile(props: Partial<Props> = {}) {
  const base: Props = {
    transport: pendingTransport,
    account: undefined,
    providerName: 'Codex',
    ...props,
  }
  const view = render(<ProfileSettings {...base} />)
  return {
    ...view,
    rerenderProfile: (next: Partial<Props>) =>
      view.rerender(<ProfileSettings {...base} {...next} />),
  }
}

/** A colour as happy-dom stores it in an inline style. */
function styled(color: string): string {
  const probe = document.createElement('div')
  probe.style.fill = color
  return probe.style.fill
}

/** What the coin should show for `name`: its ground and every painted tile's ink. */
function expectedFace(name: string) {
  const avatar = generatedAvatar(name)
  if (avatar.style !== 'mandala') throw new Error('expected the mandala style')
  return {
    ground: styled(avatar.ground),
    inks: [...avatar.rings.flat(), avatar.core]
      .filter((cell) => cell !== CELL.ground)
      .map((cell) => styled(cell === CELL.glint ? avatar.inks[1] : avatar.inks[0])),
  }
}

function renderedFace() {
  const svg = document.querySelector<SVGElement>('.profile-coin__mandala')!
  return {
    ground: svg.querySelector<SVGElement>('.profile-coin__ground')!.style.fill,
    inks: Array.from(
      svg.querySelectorAll<SVGElement>('.profile-coin__tile:not([data-ground])'),
    ).map((tile) => tile.style.fill),
  }
}

async function minted() {
  await waitFor(() => expect(document.querySelector('[data-minted]')).toBeTruthy())
}

function fileInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[type="file"]')!
}

function coin(): HTMLElement {
  return document.querySelector<HTMLElement>('.profile-coin')!
}

function action(name: string): HTMLElement {
  return screen.getByRole('button', { name })
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
    expect(screen.getByRole('textbox', { name: 'Display name' }).getAttribute('placeholder')).toBe(
      'Local profile',
    )
    await minted()
    expect(renderedFace()).toEqual(expectedFace('Local profile'))
    expect(screen.queryByText('@blue.emi')).toBeNull()
    expect(screen.getByText('Pro plan')).toBeTruthy()
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

  it('reserves the plan in the facts while the account loads and fills the same slot', () => {
    const view = renderProfile({ accountLoading: true })
    const loading = screen.getByText('Loading account plan…').closest('[role="status"]')!
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.classList.contains('profile__plan')).toBe(true)
    expect(screen.getByText('Loading account plan…').className).toBe('visually-hidden')
    expect(loading.querySelector('.skeleton')?.getAttribute('style')).toContain('height: 9px')
    const editor = screen.getByRole('textbox', { name: 'Display name' })

    view.rerenderProfile({ accountLoading: false, account: { signedIn: true, plan: 'Pro' } })
    expect(screen.queryByText('Loading account plan…')).toBeNull()
    expect(screen.getByText('Pro plan').classList.contains('profile__plan')).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBe(editor)
  })

  it('leaves the plan out without an account or a request for one', () => {
    const view = renderProfile()
    expect(view.container.querySelector('.profile__plan')).toBeNull()
    view.rerenderProfile({ account: { signedIn: false } })
    expect(view.container.querySelector('.profile__plan')).toBeNull()
  })

  it('keeps an already known plan visible during account refresh', () => {
    renderProfile({ account: { signedIn: true, plan: 'Pro' }, accountLoading: true })
    expect(screen.getByText('Pro plan')).toBeTruthy()
    expect(screen.queryByText('Loading account plan…')).toBeNull()
  })

  it('shows the local identity without the account email or provider', async () => {
    renderProfile({
      account: { signedIn: true, email: 'blue.emi@example.com', plan: 'Pro' },
      providerName: 'Grok',
    })
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy()
    const name = screen.getByRole('textbox', { name: 'Display name' })
    expect(name.getAttribute('placeholder')).toBe('Local profile')
    expect(screen.getByText('Struck from your name')).toBeTruthy()
    await minted()
    expect(renderedFace()).toEqual(expectedFace('Local profile'))
    expect(screen.queryByText(/blue\.emi/u)).toBeNull()
    expect(screen.queryByText('Grok')).toBeNull()
  })

  it('writes the name in place and strikes the seal again once typing pauses', async () => {
    const onIdentityChange = vi.fn()
    const view = renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    await minted()
    expect(renderedFace()).toEqual(expectedFace('Leon'))

    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Bluedev' },
    })
    expect(onIdentityChange).toHaveBeenLastCalledWith({ displayName: 'Bluedev' })

    vi.useFakeTimers()
    view.rerenderProfile({ identity: { displayName: 'Bluedev' }, onIdentityChange })
    act(() => vi.advanceTimersByTime(STRIKE_DELAY_MS - 1))
    expect(renderedFace()).toEqual(expectedFace('Leon'))
    act(() => vi.advanceTimersByTime(1))
    expect(renderedFace()).toEqual(expectedFace('Bluedev'))
  })

  it('turns over to the photo face, takes a photo and turns back to the seal', async () => {
    const onIdentityChange = vi.fn()
    const view = renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    const pick = vi.spyOn(fileInput(), 'click').mockImplementation(() => {})
    expect(coin().dataset.side).toBe('seal')
    expect(coin().getAttribute('title')).toBe('Turn over for a photo')

    fireEvent.click(action('Turn over for a photo'))
    expect(coin().dataset.side).toBe('photo')
    expect(pick).toHaveBeenCalledTimes(1)
    expect(screen.getByText('PNG, JPEG or WebP up to 1 MB')).toBeTruthy()
    expect(screen.getByText('Drop a photo')).toBeTruthy()

    fireEvent.change(fileInput(), {
      target: { files: [new File(['nope'], 'avatar.png', { type: 'image/png' })] },
    })
    expect((await screen.findByRole('alert')).textContent).toContain('not a valid image')
    fireEvent.change(fileInput(), {
      target: { files: [new File([PNG], 'avatar.png', { type: 'image/png' })] },
    })
    await waitFor(() =>
      expect(onIdentityChange).toHaveBeenLastCalledWith({
        avatarDataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
      }),
    )

    view.rerenderProfile({
      identity: { displayName: 'Leon', avatarDataUrl: PHOTO },
      onIdentityChange,
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.profile-coin__picture img')?.getAttribute('src')).toBe(PHOTO)
    expect(screen.getByText('Your photo · PNG, 8 B')).toBeTruthy()
    fireEvent.click(action('Replace'))
    expect(pick).toHaveBeenCalledTimes(2)

    fireEvent.click(action('Turn back'))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarDataUrl: undefined })
    view.rerenderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    expect(coin().dataset.side).toBe('seal')
    // The photo stays on the face turned away, ready to come back.
    expect(document.querySelector('.profile-coin__picture img')?.getAttribute('src')).toBe(PHOTO)

    fireEvent.click(action('Turn over to your photo'))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarDataUrl: PHOTO })
    expect(pick).toHaveBeenCalledTimes(2)
  })

  it('turns when the coin itself is clicked and back without a photo', () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    vi.spyOn(fileInput(), 'click').mockImplementation(() => {})

    fireEvent.click(coin())
    expect(coin().dataset.side).toBe('photo')
    expect(coin().getAttribute('title')).toBe('Turn back to the seal')
    fireEvent.click(coin())
    expect(coin().dataset.side).toBe('seal')
    expect(onIdentityChange).not.toHaveBeenCalled()
  })

  it('swings when the cursor brushes across it and comes back to rest', async () => {
    renderProfile({ identity: { displayName: 'Leon' } })
    const tilt = document.querySelector<HTMLElement>('.profile-coin__tilt')!
    const swing = () => Number(tilt.style.getPropertyValue('--nudge-y') || 0)

    // A still cursor, or a touch, does not move it.
    fireEvent.pointerMove(coin(), { clientX: 120, clientY: 80, pointerType: 'mouse' })
    fireEvent.pointerMove(coin(), { clientX: 120, clientY: 80, pointerType: 'mouse' })
    fireEvent.pointerMove(coin(), { clientX: 20, clientY: 80, pointerType: 'touch' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(swing()).toBe(0)

    fireEvent.pointerLeave(coin())
    fireEvent.pointerMove(coin(), { clientX: 40, clientY: 80, pointerType: 'mouse' })
    fireEvent.pointerMove(coin(), { clientX: 120, clientY: 80, pointerType: 'mouse' })
    await waitFor(() => expect(swing()).toBeGreaterThan(4))
    await waitFor(() => expect(Math.abs(swing())).toBeLessThan(0.5), { timeout: 4000 })
  })

  it('strikes the seal from any word and keeps it only when asked', async () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    await minted()

    fireEvent.click(action('Strike from a word'))
    const word = screen.getByRole('textbox', { name: 'Struck from' })
    expect(document.activeElement).toBe(word)
    expect(word.getAttribute('placeholder')).toBe('Leon')

    fireEvent.change(word, { target: { value: 'harbor' } })
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('harbor')))
    expect(onIdentityChange).not.toHaveBeenCalled()

    fireEvent.click(action('Keep this seal'))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarSeed: 'harbor' })
    expect(screen.queryByRole('textbox', { name: 'Struck from' })).toBeNull()
  })

  it('leaves a tried word with Cancel or Escape, without closing Settings', async () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    await minted()

    fireEvent.click(action('Strike from a word'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Struck from' }), {
      target: { value: 'ember' },
    })
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('ember')))
    fireEvent.click(action('Cancel'))
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('Leon')))

    fireEvent.click(action('Strike from a word'))
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => screen.getByRole('textbox', { name: 'Struck from' }).dispatchEvent(escape))
    expect(escape.defaultPrevented).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Struck from' })).toBeNull()
    expect(onIdentityChange).not.toHaveBeenCalled()
  })

  it('explains the tried word on the coin itself behind the "?", only while trying', async () => {
    renderProfile({ identity: { displayName: 'Leon' } })
    expect(screen.queryByRole('button', { name: 'How a seal is struck' })).toBeNull()

    fireEvent.click(action('Strike from a word'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Struck from' }), {
      target: { value: 'harbor' },
    })
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('harbor')))
    const help = screen.getByRole('button', { name: 'How a seal is struck' })
    expect(help.getAttribute('aria-expanded')).toBe('false')
    expect(coin().hasAttribute('data-explaining')).toBe(false)

    fireEvent.pointerEnter(help)
    expect(help.getAttribute('aria-expanded')).toBe('true')
    const notes = document.getElementById(help.getAttribute('aria-controls')!)!
    expect(notes.textContent).toContain('h picks the colour')
    expect(notes.textContent).toContain('ends in r, so dark')
    expect(notes.textContent).toContain('6 letters, four slices')
    expect(screen.getByText('3, 6, 9: four slices').hasAttribute('data-current')).toBe(true)
    expect(coin().hasAttribute('data-explaining')).toBe(true)
    // The slice that repeats carries the letters that laid it: h, a, r on the outer ring.
    const letters = [...document.querySelectorAll('.profile-coin__letters text')].map(
      (text) => text.textContent,
    )
    expect(letters.slice(0, 3)).toEqual(['h', 'a', 'r'])

    fireEvent.pointerLeave(help)
    expect(help.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(help.getAttribute('aria-controls')!)).toBeNull()

    // A click pins the notes open; Escape closes them without closing Settings.
    fireEvent.click(help)
    fireEvent.pointerLeave(help)
    expect(help.getAttribute('aria-pressed')).toBe('true')
    expect(help.getAttribute('aria-expanded')).toBe('true')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => help.dispatchEvent(escape))
    expect(escape.defaultPrevented).toBe(true)
    expect(help.getAttribute('aria-expanded')).toBe('false')
  })

  it('goes back to the name from a kept word in one step', async () => {
    const onIdentityChange = vi.fn()
    const view = renderProfile({
      identity: { displayName: 'Leon', avatarSeed: 'lantern' },
      onIdentityChange,
    })
    await minted()
    expect(renderedFace()).toEqual(expectedFace('lantern'))

    fireEvent.click(action('Back to your name'))
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarSeed: undefined })

    view.rerenderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    expect(screen.getByText('Struck from your name')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to your name' })).toBeNull()
    await waitFor(() => expect(renderedFace()).toEqual(expectedFace('Leon')))
  })

  it('rolls a word to try with the die', () => {
    renderProfile({ identity: { displayName: 'Leon' } })
    fireEvent.click(action('Strike from a word'))
    const word = screen.getByRole<HTMLInputElement>('textbox', { name: 'Struck from' })

    fireEvent.click(screen.getByRole('button', { name: 'Another word' }))
    const first = word.value
    expect(first).toMatch(/^[a-z]+$/u)
    fireEvent.click(screen.getByRole('button', { name: 'Another word' }))
    expect(word.value).not.toBe(first)
  })

  it('shows the kept word and goes back to the name when the word is cleared', async () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon', avatarSeed: 'lantern' }, onIdentityChange })
    expect(screen.getByText('Struck from \u201clantern\u201d')).toBeTruthy()
    await minted()
    expect(renderedFace()).toEqual(expectedFace('lantern'))

    fireEvent.click(action('Strike from a word'))
    const word = screen.getByRole<HTMLInputElement>('textbox', { name: 'Struck from' })
    expect(word.value).toBe('lantern')
    fireEvent.change(word, { target: { value: '' } })
    fireEvent.keyDown(word, { key: 'Enter' })
    expect(onIdentityChange).toHaveBeenLastCalledWith({ avatarSeed: undefined })
  })

  it('turns to the photo face while a photo is dragged in and takes the drop', async () => {
    const onIdentityChange = vi.fn()
    renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    const page = document.querySelector<HTMLElement>('.profile')!
    const file = new File([PNG], 'me.png', { type: 'image/png' })

    fireEvent.dragEnter(page, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(coin().dataset.side).toBe('photo')
    expect(coin().hasAttribute('data-dropping')).toBe(true)
    expect(screen.getByText('Drop to use this photo')).toBeTruthy()
    fireEvent.dragLeave(page, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(coin().dataset.side).toBe('seal')

    fireEvent.dragEnter(page, { dataTransfer: { types: ['Files'], files: [file] } })
    fireEvent.drop(page, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(coin().hasAttribute('data-dropping')).toBe(false)
    await waitFor(() =>
      expect(onIdentityChange).toHaveBeenLastCalledWith({
        avatarDataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
      }),
    )
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
    const view = renderProfile({ identity: { displayName: 'Leon' }, onIdentityChange })
    fireEvent.change(fileInput(), { target: { files: [file] } })
    view.unmount()
    finishRead(PNG.buffer)
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
