// @vitest-environment happy-dom
import type { ProviderStatus, ResultOf } from '@harness/contracts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Onboarding, providerReadiness } from './Onboarding.js'

const desktop = vi.hoisted(() => ({
  enabled: false,
  edition: undefined as 'release' | 'dev' | undefined,
  setTheme: vi.fn((_preference: string) => Promise.resolve()),
}))
vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  get isDesktop() {
    return desktop.enabled
  },
  get buildEdition() {
    return desktop.edition
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
    providersLoading: false,
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

const toAgentsPage = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Get started/ }))
  next()
  next()
  expect(screen.getByRole('heading', { name: 'Choose your coding agents' })).toBeTruthy()
}

// Every name the agents page could ever list, the ones a build leaves out included.
const PROVIDER_NAMES = /\b(Claude Code|Codex|Grok|Cursor|OpenCode|Antigravity|Pi|Devin)\b/
const LOADING_LINE = 'Looking for the coding agents installed on this machine…'
const PENDING: Partial<Props> = {
  providerStatuses: [],
  providersLoading: true,
  acpAgents: undefined,
}
// What a release build answers: five providers and no ACP entry.
const RELEASE_STATUSES: ProviderStatus[] = [
  { id: 'claude-code', displayName: 'Claude Code', installed: true, auth: 'unknown' },
  codexReady,
  grokMissing,
  { id: 'cursor', displayName: 'Cursor', installed: false, auth: 'unauthenticated' },
  { id: 'antigravity', displayName: 'Antigravity', installed: false, auth: 'unauthenticated' },
]
const RELEASE_ANSWER: Partial<Props> = {
  providerStatuses: RELEASE_STATUSES,
  providersLoading: false,
  acpAgents: [],
}

const dialogText = () => screen.getByRole('dialog').textContent ?? ''
const pickRows = () => document.querySelectorAll('.onboarding__pick .onboarding__pick-row')
const busy = () => document.querySelector('.onboarding__pick [aria-busy="true"]')
const lead = () => document.querySelector('.onboarding__lead')?.textContent

describe('first-run onboarding', () => {
  it('walks welcome → name → appearance → agents → sub-agents → project and keeps progress honest', () => {
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

    expect(screen.getByRole('heading', { name: 'Sub-agents on other providers' })).toBeTruthy()
    expect(current()).toBe('Sub-agents')
    // An open answer counts as off, so "Only when I ask" shows as the choice in
    // effect; moving on leaves the answer open.
    expect(
      screen
        .getAllByRole('radio')
        .filter((radio) => (radio as HTMLInputElement).checked)
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual([expect.stringMatching(/^Only when I ask/)])
    next()

    expect(screen.getByRole('heading', { name: 'Open your first project' })).toBeTruthy()
    expect(current()).toBe('First project')
    expect(progress.querySelectorAll('.is-done')).toHaveLength(6)
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
      'Pick the ones you use. Nothing is added until you do.',
    )
    const providers = screen.getByRole('region', { name: 'Providers' })
    const agents = screen.getByRole('region', { name: 'ACP agents' })
    // Only the providers this server reports, each with its state; the maker is its tooltip.
    expect(providers.textContent).toBe('ProvidersCodexSigned inGrokNot installed')
    expect(agents.textContent).toBe('ACP agentsDevinInstalled')
    expect(
      within(agents)
        .getByRole('checkbox', { name: /^Devin/ })
        .closest('label')?.title,
    ).toBe('Cognition')

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

  it('ends the welcome animation at once on the first click or key', () => {
    renderOnboarding()
    const dialog = screen.getByRole('dialog')
    expect(dialog.hasAttribute('data-intro')).toBe(false)
    fireEvent.pointerDown(dialog)
    expect(dialog.getAttribute('data-intro')).toBe('skipped')
    // Skipping is not advancing: the welcome page stays.
    expect(screen.getByRole('heading', { name: 'Welcome to TasteCode' })).toBeTruthy()
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

describe('agents page before the provider list answers', () => {
  afterEach(() => {
    desktop.edition = undefined
  })

  function renderPending(overrides: Partial<Props> = {}) {
    const props = onboardingProps({ ...PENDING, ...overrides })
    const view = render(<Onboarding {...props} />)
    return {
      answer: (answer: Partial<Props>) => view.rerender(<Onboarding {...props} {...answer} />),
    }
  }

  it('holds placeholders in the final layout and names no provider', () => {
    desktop.edition = 'release'
    renderPending()
    toAgentsPage()

    expect(dialogText()).not.toMatch(PROVIDER_NAMES)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    // The status line already reads as it will once the list is in.
    expect(lead()).toBe('Pick the ones you use. Nothing is added until you do.')
    expect(busy()?.textContent).toBe(LOADING_LINE)
    // As many lines as a release build lists, under the heading the list keeps.
    expect(screen.getByRole('region', { name: 'Providers' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'ACP agents' })).toBeNull()
    expect(pickRows()).toHaveLength(5)
  })

  it.each([
    ['a dev build', 'dev'],
    ['an unpackaged run', undefined],
  ] as const)("holds the whole list's shape in %s, ACP group included", (_name, edition) => {
    desktop.edition = edition
    const page = renderPending()
    toAgentsPage()
    const lines = (group: string) =>
      screen.getByRole('region', { name: group }).querySelectorAll('.onboarding__pick-row')

    expect(dialogText()).not.toMatch(PROVIDER_NAMES)
    expect(lines('Providers')).toHaveLength(7)
    expect(lines('ACP agents').length).toBeGreaterThan(0)
    // One loading line for the whole list, not one per group.
    expect(document.querySelectorAll('.onboarding__pick [role="status"]')).toHaveLength(1)
    expect(busy()?.textContent).toBe(LOADING_LINE)

    // Every provider and the ACP library, as a dev build's server lists them.
    const statuses = [
      'claude-code',
      'codex',
      'grok',
      'cursor',
      'opencode',
      'antigravity',
      'pi',
      'acp',
    ].map((id): ProviderStatus => ({
      id: id as ProviderStatus['id'],
      displayName: id,
      installed: false,
      auth: 'unauthenticated',
    }))
    page.answer({ providerStatuses: statuses, providersLoading: false, acpAgents: [devin] })
    expect(busy()).toBeNull()
    expect(
      [...document.querySelectorAll('.onboarding__pick .onboarding__pick-title')].map(
        (title) => title.textContent,
      ),
    ).toEqual(['Providers', 'ACP agents'])
    expect(lines('Providers')).toHaveLength(7)
    expect(lines('ACP agents')).toHaveLength(1)
  })

  it('fills the same lines with exactly what a release build offers', () => {
    desktop.edition = 'release'
    const page = renderPending()
    toAgentsPage()
    page.answer(RELEASE_ANSWER)

    expect(busy()).toBeNull()
    expect(screen.getByRole('region', { name: 'Providers' }).textContent).toBe(
      'Providers' +
        'Claude CodeInstalled' +
        'CodexSigned in' +
        'GrokNot installed' +
        'CursorNot installed' +
        'AntigravityNot installed',
    )
    expect(screen.queryByRole('region', { name: 'ACP agents' })).toBeNull()
    expect(dialogText()).not.toMatch(/\b(OpenCode|Pi)\b/)
    expect(pickRows()).toHaveLength(5)
    expect(lead()).toBe('Pick the ones you use. Nothing is added until you do.')
  })

  it('waits for the ACP library too, so no group arrives after the list', () => {
    const page = renderPending()
    toAgentsPage()
    page.answer({ providerStatuses: [codexReady], providersLoading: false })
    expect(dialogText()).not.toMatch(PROVIDER_NAMES)
    expect(busy()).toBeTruthy()

    page.answer({ providerStatuses: [codexReady], providersLoading: false, acpAgents: [devin] })
    expect(busy()).toBeNull()
    expect(screen.getByRole('region', { name: 'Providers' }).textContent).toBe(
      'ProvidersCodexSigned in',
    )
    expect(screen.getByRole('region', { name: 'ACP agents' }).textContent).toBe(
      'ACP agentsDevinInstalled',
    )
  })

  it('draws agents added earlier in the preview from the first frame and keeps them', () => {
    const page = renderPending({ providerRoster: ['codex', 'acp:devin'] })
    const picker = () => document.querySelector('.onboarding__preview [data-land="model"]')
    const drawn = () =>
      [...(picker()?.querySelectorAll('.preview__mark') ?? [])].map((mark) =>
        mark.getAttribute('data-land'),
      )
    expect(drawn()).toEqual(['agent-codex', 'agent-acp:devin'])
    expect(picker()?.textContent).toBe('Codex')

    // A release build offers no ACP agents; what was drawn still stays.
    page.answer(RELEASE_ANSWER)
    expect(drawn()).toEqual(['agent-codex', 'agent-acp:devin'])
    expect(picker()?.textContent).toBe('Codex')
  })

  it('ends in the server error when the list never comes', () => {
    const page = renderPending()
    toAgentsPage()
    page.answer({
      providersLoading: false,
      providersError: 'Could not load providers. Server offline',
      acpAgents: [],
    })

    expect(lead()).toBe('Could not load providers. Server offline')
    expect(busy()).toBeNull()
    expect(pickRows()).toHaveLength(0)
    expect(dialogText()).not.toMatch(PROVIDER_NAMES)
    // Setup goes on without it.
    next()
    next()
    expect(screen.getByRole('heading', { name: 'Open your first project' })).toBeTruthy()
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

describe('sub-agents page', () => {
  const toSubagentsPage = () => {
    toAgentsPage()
    next()
    expect(screen.getByRole('heading', { name: 'Sub-agents on other providers' })).toBeTruthy()
  }

  it('stores the answer the moment it is chosen', async () => {
    const request = vi.fn(async (method: string, params: unknown) =>
      method === 'subagents.updateSettings' ? params : {},
    )
    renderOnboarding({ transport: { request } as unknown as Props['transport'] })
    toSubagentsPage()
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /^Allow/ }))
    })
    expect(request).toHaveBeenCalledWith('subagents.updateSettings', { otherProviders: true })
    expect((screen.getByRole('radio', { name: /^Allow/ }) as HTMLInputElement).checked).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /^Only when I ask/ }))
    })
    expect(request).toHaveBeenLastCalledWith('subagents.updateSettings', { otherProviders: false })
  })

  it('shows the choice in effect before an answer, without storing it', async () => {
    const request = vi.fn(async () => ({}))
    await act(async () => {
      renderOnboarding({ transport: { request } as unknown as Props['transport'] })
    })
    toSubagentsPage()
    expect(
      (screen.getByRole('radio', { name: /^Only when I ask/ }) as HTMLInputElement).checked,
    ).toBe(true)
    expect((screen.getByRole('radio', { name: /^Allow/ }) as HTMLInputElement).checked).toBe(false)
    expect(request).not.toHaveBeenCalledWith('subagents.updateSettings', expect.anything())
  })

  it('shows an earlier answer', async () => {
    const request = vi.fn(async () => ({ otherProviders: false }))
    await act(async () => {
      renderOnboarding({ transport: { request } as unknown as Props['transport'] })
    })
    toSubagentsPage()
    expect(
      (screen.getByRole('radio', { name: /^Only when I ask/ }) as HTMLInputElement).checked,
    ).toBe(true)
  })
})
