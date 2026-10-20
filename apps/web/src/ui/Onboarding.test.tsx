// @vitest-environment happy-dom
import type { ProviderStatus, ResultOf } from '@harness/contracts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Onboarding, providerReadiness } from './Onboarding.js'

const desktop = vi.hoisted(() => ({
  enabled: false,
  setTheme: vi.fn((_preference: string) => Promise.resolve()),
}))
vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  get isDesktop() {
    return desktop.enabled
  },
  setDesktopTheme: desktop.setTheme,
}))

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

const devin: ResultOf<'acp.agents'>['agents'][number] = {
  id: 'devin',
  name: 'Devin',
  maker: 'Cognition',
  installed: true,
  verified: true,
  setup: { installUrl: 'https://example.test/devin', login: 'provider' },
}

type Props = Parameters<typeof Onboarding>[0]

function onboardingProps(overrides: Partial<Props> = {}): Props {
  return {
    themePreference: 'system',
    onThemePreferenceChange: vi.fn(),
    onDisplayNameChange: vi.fn(),
    providerStatuses: [codexReady, grokMissing],
    acpAgents: [devin],
    providerRoster: [],
    onProviderRosterChange: vi.fn(),
    onAddProject: vi.fn(),
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

    expect(screen.getByRole('heading', { name: 'Choose your coding agents' })).toBeTruthy()
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

  it('offers the providers and the ACP library with nothing added', () => {
    const props = renderOnboarding()
    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
    next()
    next()

    expect(screen.getByRole('status').textContent).toBe(
      'Add the ones you use. Nothing is added until you pick it.',
    )
    const providers = screen.getByRole('region', { name: 'Providers' })
    const agents = screen.getByRole('region', { name: 'ACP agents' })
    // Only the providers this server reports, each with its maker and state.
    expect(providers.textContent).toBe(
      'ProvidersCodexOpenAI · Signed inAddGrokxAI · Not installedAdd',
    )
    expect(agents.textContent).toBe('ACP agentsDevinCognition · InstalledAdd')

    fireEvent.click(within(providers).getByRole('checkbox', { name: /^Codex/ }))
    expect(props.onProviderRosterChange).toHaveBeenCalledWith(['codex'])
  })

  it('counts what is added and takes one away again', () => {
    const props = renderOnboarding({ providerRoster: ['codex', 'acp:devin'] })
    fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
    next()
    next()

    expect(screen.getByRole('status').textContent).toContain('2 added.')
    const codex = screen.getByRole('checkbox', { name: /^Codex/ }) as HTMLInputElement
    expect(codex.checked).toBe(true)
    fireEvent.click(codex)
    expect(props.onProviderRosterChange).toHaveBeenCalledWith(['acp:devin'])
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

  it('lands an agent in the preview model picker once it is added', async () => {
    function Stateful() {
      const [roster, setRoster] = useState<readonly string[]>([])
      return (
        <Onboarding
          {...onboardingProps({ providerRoster: roster, onProviderRosterChange: setRoster })}
        />
      )
    }
    vi.useFakeTimers()
    try {
      render(<Stateful />)
      const picker = () => document.querySelector('.onboarding__preview [data-land="model"]')
      fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
      await act(async () => next())
      next()
      await act(async () => vi.advanceTimersByTime(2_000))
      // Nothing arrives on its own, ready or not.
      expect(picker()?.textContent).toBe('Choose model')

      fireEvent.click(screen.getByRole('checkbox', { name: /^Devin/ }))
      await act(async () => vi.advanceTimersByTime(2_000))
      expect(picker()?.querySelectorAll('.preview__mark:not([data-arriving])')).toHaveLength(1)
      expect(picker()?.textContent).toBe('Devin')

      fireEvent.click(screen.getByRole('checkbox', { name: /^Devin/ }))
      expect(picker()?.textContent).toBe('Choose model')
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
    expect(screen.getByRole('heading', { name: 'Choose your coding agents' })).toBeTruthy()

    view.rerender(<Onboarding {...props} hidden />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.onboarding')?.hasAttribute('hidden')).toBe(true)

    view.rerender(<Onboarding {...props} />)
    expect(screen.getByRole('heading', { name: 'Choose your coding agents' })).toBeTruthy()
  })

  it('pins the window theme again when a pending System choice gives way to the current one', () => {
    desktop.enabled = true
    document.documentElement.dataset.theme = 'dark'
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn() })
    try {
      const props = renderOnboarding({ themePreference: 'dark' })
      fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
      next()

      fireEvent.click(screen.getByRole('radio', { name: /^System/ }))
      expect(desktop.setTheme).toHaveBeenLastCalledWith('system')
      fireEvent.click(screen.getByRole('radio', { name: /^Dark/ }))

      expect(props.onThemePreferenceChange).toHaveBeenCalledWith('dark')
      expect(desktop.setTheme).toHaveBeenLastCalledWith('dark')
    } finally {
      desktop.enabled = false
      delete document.documentElement.dataset.theme
      Reflect.deleteProperty(document, 'startViewTransition')
    }
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
    expect(providerReadiness(codexReady)).toEqual({ label: 'Signed in', tone: 'ready' })
  })
})
