// @vitest-environment happy-dom
import type { ProviderStatus } from '@harness/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Onboarding, providerReadiness } from './Onboarding.js'

afterEach(cleanup)

const codexReady: ProviderStatus = {
  id: 'codex',
  displayName: 'Codex',
  installed: true,
  auth: 'authenticated',
}
const grokMissing: ProviderStatus = {
  id: 'grok',
  displayName: 'Grok',
  installed: false,
  auth: 'unauthenticated',
}

type Props = Parameters<typeof Onboarding>[0]

function onboardingProps(overrides: Partial<Props> = {}): Props {
  return {
    themePreference: 'system',
    onThemePreferenceChange: vi.fn(),
    onDisplayNameChange: vi.fn(),
    providerStatuses: [codexReady, grokMissing],
    onAddProject: vi.fn(),
    onOpenProviders: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

function renderOnboarding(overrides: Partial<Props> = {}) {
  const props = onboardingProps(overrides)
  render(<Onboarding {...props} />)
  return props
}

const next = () => fireEvent.click(screen.getByRole('button', { name: /^Continue/ }))

describe('first-run onboarding', () => {
  it('walks welcome → name → appearance → agents → project and keeps progress honest', () => {
    const props = renderOnboarding({ displayName: 'Blue Emi' })
    const progress = screen.getByRole('list', { name: 'Setup progress' })
    const current = () => progress.querySelector('[aria-current="step"]')?.textContent

    expect(screen.getByRole('heading', { name: 'Welcome to TasteCode' })).toBeTruthy()
    expect(current()).toBe('Welcome')
    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))

    expect(screen.getByRole('heading', { name: 'What should we call you?' })).toBeTruthy()
    expect(current()).toBe('Your name')
    expect(document.querySelector('.onboarding__avatar .generated-avatar')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Your name' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Your name' }), {
      target: { value: 'Leon' },
    })
    expect(props.onDisplayNameChange).toHaveBeenCalledWith('Leon')
    next()

    expect(screen.getByRole('heading', { name: 'Choose your look' })).toBeTruthy()
    expect(current()).toBe('Appearance')
    fireEvent.click(screen.getByRole('radio', { name: /^Dark/ }))
    expect(props.onThemePreferenceChange).toHaveBeenCalledWith('dark')
    next()

    expect(screen.getByRole('heading', { name: 'Your coding agents' })).toBeTruthy()
    expect(current()).toBe('Coding agents')
    next()

    expect(screen.getByRole('heading', { name: 'Open your first project' })).toBeTruthy()
    expect(current()).toBe('First project')
    expect(progress.querySelectorAll('.is-done')).toHaveLength(5)
    expect(screen.queryByRole('button', { name: 'Skip setup' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Choose a folder/ }))
    expect(props.onAddProject).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })

  it('covers exactly the three beta plans and routes setup into provider settings', () => {
    const props = renderOnboarding()
    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
    next()
    next()

    const plans = screen.getByRole('list', { name: 'Supported beta plans' })
    expect(plans.querySelectorAll('.onboarding__provider')).toHaveLength(3)
    expect(plans.textContent).toContain('CodexOpenAIReady')
    expect(plans.textContent).toContain('Claude CodeAnthropicChecking…')
    expect(plans.textContent).toContain('GrokxAINot installedSet up')
    expect(screen.getByRole('status').textContent).toContain('Looking for the coding agents')

    // Only the row that needs something offers the action; ready and
    // still-checking rows stay plain text.
    expect(screen.getAllByRole('button', { name: /^Set up / })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Set up Grok' }))
    expect(props.onOpenProviders).toHaveBeenCalledOnce()
  })

  it('offers no setup action once every plan is ready', () => {
    renderOnboarding({
      providerStatuses: [
        codexReady,
        { ...codexReady, id: 'claude-code', displayName: 'Claude Code' },
        { ...codexReady, id: 'grok', displayName: 'Grok', auth: 'unknown' },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
    next()
    next()

    expect(screen.getByRole('status').textContent).toContain('All three beta plans are ready')
    expect(screen.queryByRole('button', { name: /^Set up / })).toBeNull()
  })

  it('advances with Enter from bare surfaces and inputs but not from buttons', () => {
    renderOnboarding()
    const dialog = screen.getByRole('dialog')

    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(screen.getByRole('heading', { name: 'What should we call you?' })).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your name' }), { key: 'Enter' })
    expect(screen.getByRole('heading', { name: 'Choose your look' })).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Back' }), { key: 'Enter' })
    expect(screen.getByRole('heading', { name: 'Choose your look' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('heading', { name: 'What should we call you?' })).toBeTruthy()
  })

  it('dismisses with Escape and from the bar, once per page even when asked twice', () => {
    const escaped = renderOnboarding()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    // The page is already dissolving; a second request must not fire again.
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    expect(escaped.onDismiss).toHaveBeenCalledOnce()
    cleanup()

    const skipped = renderOnboarding()
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    expect(skipped.onDismiss).toHaveBeenCalledOnce()
  })

  it('jumps to any page already seen from the progress dots, never past it', () => {
    renderOnboarding()
    const progress = screen.getByRole('list', { name: 'Setup progress' })
    // Nothing has been seen yet, so there is nowhere to jump.
    expect(progress.querySelectorAll('button')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
    next()
    expect(screen.getByRole('heading', { name: 'Choose your look' })).toBeTruthy()
    expect(progress.querySelectorAll('button')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Welcome' }))
    expect(screen.getByRole('heading', { name: 'Welcome to TasteCode' })).toBeTruthy()
    // Pages ahead that were already visited stay reachable.
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(screen.getByRole('heading', { name: 'Choose your look' })).toBeTruthy()
  })

  it('hands the name to the preview only when the name page is left', async () => {
    const props = onboardingProps({ displayName: '' })
    const view = render(<Onboarding {...props} />)
    const shown = () =>
      document.querySelector('.onboarding__preview [data-land="name"]')?.textContent
    expect(shown()).toBe('Local profile')

    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
    view.rerender(<Onboarding {...props} displayName="Leon" />)
    // Typing shapes the big avatar; the app only receives the name on Continue.
    expect(shown()).toBe('Local profile')
    await act(async () => next())
    expect(shown()).toBe('Leon')
  })

  it('lands each detected agent in the preview model picker', async () => {
    vi.useFakeTimers()
    try {
      renderOnboarding()
      const picker = () => document.querySelector('.onboarding__preview [data-land="model"]')
      expect(picker()?.textContent).toBe('Choose model')

      fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
      await act(async () => next())
      next()
      expect(picker()?.textContent).toBe('Choose model')
      await act(async () => vi.advanceTimersByTime(2_000))

      // Only the ready plan arrives; Grok is not installed and Claude Code is still checking.
      expect(picker()?.querySelectorAll('.preview__mark:not([data-arriving])')).toHaveLength(1)
      expect(picker()?.textContent).toBe('Codex')
    } finally {
      vi.useRealTimers()
    }
  })

  it('makes room in the preview for the project about to be chosen', async () => {
    renderOnboarding()
    const incoming = () =>
      document.querySelector('.onboarding__preview .preview__incoming')?.getAttribute('data-state')
    expect(incoming()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
    await act(async () => next())
    next()
    next()
    expect(incoming()).toBe('open')

    const choose = screen.getByRole('button', { name: /^Choose a folder/ })
    fireEvent.pointerEnter(choose)
    expect(incoming()).toBe('ready')
    fireEvent.pointerLeave(choose)
    expect(incoming()).toBe('open')
  })

  it('plays its way out once setup is finished elsewhere', () => {
    const props = onboardingProps()
    const view = render(<Onboarding {...props} />)
    expect(props.onDismiss).not.toHaveBeenCalled()
    view.rerender(<Onboarding {...props} finished />)
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })

  it('keeps its page while hidden behind Settings', () => {
    const props = onboardingProps()
    const view = render(<Onboarding {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
    next()
    next()
    expect(screen.getByRole('heading', { name: 'Your coding agents' })).toBeTruthy()

    view.rerender(<Onboarding {...props} hidden />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.onboarding')?.hasAttribute('hidden')).toBe(true)

    view.rerender(<Onboarding {...props} />)
    expect(screen.getByRole('heading', { name: 'Your coding agents' })).toBeTruthy()
  })
})

describe('providerReadiness', () => {
  it('turns vendor status into one honest line', () => {
    expect(providerReadiness(undefined)).toEqual({ label: 'Checking…', tone: 'checking' })
    expect(providerReadiness(grokMissing)).toEqual({ label: 'Not installed', tone: 'pending' })
    expect(providerReadiness({ ...codexReady, auth: 'unauthenticated' })).toEqual({
      label: 'Sign in needed',
      tone: 'pending',
    })
    expect(providerReadiness({ ...codexReady, problem: 'Login path retired' })).toEqual({
      label: 'Needs attention',
      tone: 'pending',
    })
    expect(providerReadiness({ ...codexReady, auth: 'unknown' })).toEqual({
      label: 'Installed',
      tone: 'ready',
    })
    expect(providerReadiness(codexReady)).toEqual({ label: 'Ready', tone: 'ready' })
  })
})
