// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { methods, type Account, type ProviderId, type ResultOf } from '@harness/contracts'
import { customModelChoice, type ModelChoice } from '../model-catalog.js'
import { MODEL_PICKER_LAYOUT_KEY, writeModelPickerLayout } from '../model-picker-layout.js'
import { resetInstalls } from '../provider-install.js'
import { providerUpdatesStore } from '../provider-updates.js'
import { SIMULATED_CHECK_MS, stopAppUpdateSimulation } from '../app-update-simulation.js'
import { HAPTICS_KEY, writeAppHaptics } from '../haptics.js'
import { TERMINAL_PLACEMENT_KEY, writeTerminalPlacement } from '../terminal-placement.js'
import type { Transport } from '../transport.js'
import { TestTransport, type TestRequestResolver } from '../test-transport.js'
import { ProviderSettings, Settings } from './Settings.js'
import { createDefaultKeybindings, type KeybindingId, type Shortcut } from '../shortcuts.js'
import * as bridge from '../bridge.js'

type ProviderStatus = ResultOf<'providers.list'>['providers'][number]

const settingsLoading = vi.hoisted(() => ({
  desktop: false,
  terminal: undefined as Promise<void> | undefined,
}))

vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  get isDesktop() {
    return settingsLoading.desktop
  },
}))

vi.mock('./InstallTerminal.js', () => ({
  InstallTerminal: (props: { installKey: string }) => {
    if (settingsLoading.terminal) throw settingsLoading.terminal
    return <div data-testid="install-terminal" data-install-key={props.installKey} />
  },
}))

function renderSettings(
  options: {
    initialSection?: 'workflows' | 'appearance' | 'models' | 'keybinds' | 'data' | 'debug' | 'about'
    showDebug?: boolean
    onClose?: () => void
    onReset?: () => void
    transport?: Transport
    showMacOSHaptics?: boolean
    onKeybindingChange?: (action: KeybindingId, shortcut: Shortcut | null) => void
    onKeybindingsReset?: () => void
    overrides?: Partial<ComponentProps<typeof Settings>>
  } = {},
) {
  const transport = options.transport ?? new TestTransport()

  const element = (
    <Settings
      provider="codex"
      providerName="Codex"
      transport={transport}
      projectPath={undefined}
      projectName={undefined}
      account={undefined}
      providerStatuses={[]}
      models={[]}
      hiddenModels={new Set()}
      onModelVisibilityChange={() => {}}
      onConnectionsChanged={() => {}}
      projectCount={0}
      sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
      onSidebarSettingsChange={() => {}}
      themeColorScheme="dark"
      themePreference="system"
      onThemePreferenceChange={() => {}}
      appearancePreferences={{
        light: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
        dark: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
      }}
      onAppearancePreferenceChange={() => {}}
      showMacOSFontSmoothing={false}
      macOSFontSmoothing={true}
      onMacOSFontSmoothingChange={() => {}}
      macOS={true}
      keybindings={createDefaultKeybindings()}
      onKeybindingChange={options.onKeybindingChange ?? (() => {})}
      onKeybindingsReset={options.onKeybindingsReset ?? (() => {})}
      showMacOSHaptics={options.showMacOSHaptics ?? false}
      onAccountChange={() => {}}
      initialSection={options.initialSection ?? 'appearance'}
      showDebug={options.showDebug}
      onReset={options.onReset ?? (() => {})}
      onClose={options.onClose ?? (() => {})}
      {...options.overrides}
    />
  )
  const view = render(element)
  return {
    ...view,
    rerenderSettings: (updates: Partial<ComponentProps<typeof Settings>>) =>
      view.rerender(<Settings {...element.props} {...updates} />),
  }
}

function renderAppearanceSettings(showMacOSHaptics = false) {
  return renderSettings({ showMacOSHaptics })
}

afterEach(() => {
  cleanup()
  stopAppUpdateSimulation()
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetInstalls()
  settingsLoading.desktop = false
  settingsLoading.terminal = undefined
  writeModelPickerLayout('list')
  localStorage.removeItem(MODEL_PICKER_LAYOUT_KEY)
  writeAppHaptics(true)
  localStorage.removeItem(HAPTICS_KEY)
  writeTerminalPlacement('workspace')
  localStorage.removeItem(TERMINAL_PLACEMENT_KEY)
  localStorage.removeItem('harness.providerEmail.codex')
  localStorage.removeItem('harness.providerEmail.claude-code')
  localStorage.removeItem('harness.providerEmail.grok')
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('settings viewport layout', () => {
  it('keeps both desktop panes scrollable inside short windows', () => {
    const { container } = renderSettings()
    const settings = container.querySelector('.settings')

    expect(settings?.querySelector(':scope > .settings__sidebar')).toBeTruthy()
    expect(settings?.querySelector(':scope > .settings__main')).toBeTruthy()
  })

  it('opens on General when no section is asked for', () => {
    renderSettings({ overrides: { initialSection: undefined } })

    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
  })

  it('names the foundational preference categories truthfully', () => {
    renderSettings()

    const categories = screen.getByRole('navigation', { name: 'Settings categories' })
    expect(
      within(categories)
        .getAllByRole('button')
        .slice(0, 3)
        .map((button) => button.textContent),
    ).toEqual(['General', 'Profile', 'Appearance'])

    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Model picker' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Right' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(screen.queryByRole('radiogroup', { name: 'Model picker' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }))
    expect(screen.getByRole('heading', { name: 'Data & privacy' })).toBeTruthy()
  })

  it('pairs theme previews with compact appearance controls', () => {
    renderSettings()

    expect(screen.getByRole('heading', { name: 'Theme', level: 2 })).toBeTruthy()
    expect(screen.getByRole('img', { name: /code.*preview/i })).toBeTruthy()
    expect(screen.getAllByRole('radio').map((option) => option.getAttribute('value'))).toEqual([
      'system',
      'light',
      'dark',
    ])

    expect(screen.getByRole('heading', { name: 'Light mode' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Dark mode' })).toBeTruthy()
    const details = screen.getByRole('region', { name: 'Dark mode' })
    expect(
      within(details)
        .getAllByRole('combobox')
        .map((control) => control.getAttribute('aria-label')),
    ).toEqual(['Dark mode theme', 'Interface font', 'Sidebar translucency'])
    expect(within(details).getByRole('button', { name: 'Accent palette: #4C9DFF' })).toBeTruthy()
    expect(within(details).getByRole('button', { name: 'Background: #0F0F0F' })).toBeTruthy()
  })

  it('lets the terminal shortcut target the bottom panel', () => {
    renderSettings({ initialSection: 'workflows' })

    fireEvent.click(screen.getByRole('radio', { name: 'Bottom' }))

    expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBe('bottom')
    expect(screen.getByRole('radio', { name: 'Bottom' }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('about status grammar', () => {
  it.each([
    [
      'ready',
      {
        localCommit: '1234567890',
        remote: { sha: '1234567890', message: 'Current', date: '2026-08-12' },
        upToDate: true,
      },
      'Ready · Up to date · 1234567',
    ],
    [
      'setup-needed',
      {
        localCommit: '1234567890',
        remote: { sha: 'abcdef0123', message: 'Newer', date: '2026-08-12' },
        upToDate: false,
      },
      'Setup needed · Newer: abcdef0 — pull and restart',
    ],
    ['unavailable', { localCommit: '1234567890' }, 'Unavailable · No verdict'],
  ] as const)('separates %s update state from build metadata', async (state, result, label) => {
    const update = deferred<ResultOf<'system.updateCheck'>>()
    const transport = new TestTransport((method) => {
      if (method === 'system.updateCheck') return update.promise
      throw new Error(`unexpected ${method}`)
    })
    const { container } = renderSettings({
      initialSection: 'about',
      transport,
    })

    expect((await screen.findByText('Browser · pre-release')).className).toBe('settings-meta')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(screen.getByRole('status', { name: 'Checking' }).className).toContain('is-checking')

    await act(async () => update.resolve(result))

    expect((await screen.findByRole('status', { name: label })).className).toContain(`is-${state}`)
    expect(transport.requests).toContainEqual({ method: 'system.updateCheck', params: {} })
    expect(container.querySelector('.settings__status')).toBeNull()
  })
})

describe('app update simulation', () => {
  it('plays a fake release through About and stops back to the real updater', async () => {
    vi.useFakeTimers()
    renderSettings({ initialSection: 'debug', showDebug: true })
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop.hasAttribute('disabled')).toBe(true)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Update' })))
    expect(stop.hasAttribute('disabled')).toBe(false)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'About' })))
    expect(screen.getByRole('status', { name: 'Checking' })).toBeTruthy()

    await act(() => vi.advanceTimersByTimeAsync(SIMULATED_CHECK_MS))
    expect(screen.getByRole('button', { name: 'Downloading…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/Downloading 1\.0\.0/)).toBeTruthy()

    await act(async () => stopAppUpdateSimulation())
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeTruthy()
    expect(screen.queryByRole('status', { name: /Checking/ })).toBeNull()
  })
})

describe('provider update simulation', () => {
  it('starts and stops made-up releases from Debug', () => {
    const transport = new TestTransport(() => ({ updates: [] }))
    renderSettings({ initialSection: 'debug', showDebug: true, transport })
    const stop = screen.getByRole('button', { name: 'Stop provider update simulation' })
    expect(stop.hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Three releases' }))
    expect(providerUpdatesStore(transport).snapshot()).toMatchObject({ simulation: 'several' })
    expect(providerUpdatesStore(transport).snapshot().updates).toHaveLength(3)
    expect(stop.hasAttribute('disabled')).toBe(false)

    fireEvent.click(stop)
    expect(providerUpdatesStore(transport).snapshot().simulation).toBeUndefined()
    expect(stop.hasAttribute('disabled')).toBe(true)
  })
})

describe('model picker layout setting', () => {
  it('reflects changes from the shared layout preference', () => {
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    const rail = screen.getByRole('radio', { name: 'Rail' })
    expect(rail.getAttribute('aria-checked')).toBe('false')

    act(() => writeModelPickerLayout('rail'))

    expect(rail.getAttribute('aria-checked')).toBe('true')
  })
})

describe('settings dialog keyboard behavior', () => {
  it('contains forward and reverse Tab navigation inside the dialog', () => {
    renderSettings()
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    const first = screen.getByRole('button', { name: 'Back to app' })
    const last = within(screen.getByRole('region', { name: 'Dark mode' })).getByRole('combobox', {
      name: 'Sidebar translucency',
    })

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    dialog.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    first.focus()
    const handledTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    handledTab.preventDefault()
    first.dispatchEvent(handledTab)
    expect(document.activeElement).toBe(first)
  })

  it.each([
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['Back', () => fireEvent.click(screen.getByRole('button', { name: 'Back to app' }))],
  ])('closes with %s and restores focus to the opener', (_path, close) => {
    const openerView = render(<button type="button">Open settings</button>)
    const opener = screen.getByRole('button', { name: 'Open settings' })
    opener.focus()
    const onClose = vi.fn()
    const settingsView = renderSettings({ onClose })

    close()
    expect(onClose).toHaveBeenCalledOnce()
    settingsView.unmount()
    expect(document.activeElement).toBe(opener)
    openerView.unmount()
  })

  it('leaves Escape to a nested control that handles it', () => {
    const onClose = vi.fn()
    renderSettings({ onClose })
    const nestedControl = within(screen.getByRole('region', { name: 'Dark mode' })).getByRole(
      'combobox',
      { name: 'Sidebar translucency' },
    )
    nestedControl.addEventListener('keydown', (event) => event.preventDefault())

    nestedControl.focus()
    fireEvent.keyDown(nestedControl, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(nestedControl)
  })
})

describe('settings reset confirmation', () => {
  it('explains the exact local scope and keeps cancel, Escape, and focus safe', () => {
    const onReset = vi.fn()
    renderSettings({ initialSection: 'data', onReset })

    expect(
      screen.getByText(
        'Reset only clears this renderer\u2019s preferences. It does not delete projects, workspaces, files, chat history, or provider credentials.',
      ),
    ).toBeTruthy()
    const reset = screen.getByRole('button', { name: 'Reset app preferences' })
    expect(reset.classList.contains('is-danger')).toBe(true)

    reset.focus()
    fireEvent.click(reset)
    const confirmation = screen.getByRole('alertdialog', { name: 'Reset app preferences?' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Reset and reload' })
    expect(document.activeElement).toBe(cancel)
    expect(confirmation.textContent).toContain(
      'Projects, workspaces, files, chat history, and provider credentials are not deleted.',
    )

    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    confirmation.focus()
    fireEvent.keyDown(confirmation, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
    fireEvent.keyDown(confirmation, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(document.activeElement).toBe(reset)
    expect(onReset).not.toHaveBeenCalled()

    fireEvent.click(reset)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(reset)
    expect(onReset).not.toHaveBeenCalled()

    fireEvent.click(reset)
    fireEvent.click(screen.getByRole('button', { name: 'Reset and reload' }))
    expect(onReset).toHaveBeenCalledOnce()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('settings loading values', () => {
  it('holds model source cards until the first catalog arrives', async () => {
    const { container, rerenderSettings } = renderSettings({
      initialSection: 'models',
      overrides: { modelsLoading: true },
    })
    const loading = screen.getByText('Loading models…').closest('[role="status"]')!
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.classList.contains('model-settings__sources')).toBe(true)
    expect(loading.querySelectorAll('.model-visibility')).toHaveLength(2)
    expect(loading.querySelectorAll('.model-visibility__model')).toHaveLength(7)
    expect(loading.querySelectorAll('.settings__switch-skeleton')).toHaveLength(7)
    expect(container.querySelector('.model-settings__empty')).toBeNull()
    expect(within(loading as HTMLElement).queryByRole('switch')).toBeNull()

    const models: ModelChoice[] = [
      {
        key: 'codex:luna',
        provider: 'codex',
        sourceName: 'Codex',
        mark: 'openai',
        model: {
          id: 'luna',
          displayName: 'Luna',
          isDefault: true,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      },
    ]
    rerenderSettings({ modelsLoading: false, models })
    expect(screen.queryByText('Loading models…')).toBeNull()
    expect(screen.getByRole('switch', { name: 'Include Luna in model picker' })).toBeTruthy()

    rerenderSettings({ modelsLoading: true, models })
    expect(screen.queryByText('Loading models…')).toBeNull()
    expect(screen.getByRole('switch', { name: 'Include Luna in model picker' })).toBeTruthy()

    rerenderSettings({ modelsLoading: false, models: [] })
    expect(
      screen.getByText('No models are available from your connected providers yet.'),
    ).toBeTruthy()
    await act(async () => {})
  })

  it('loads the background model value and note without guessing Automatic', async () => {
    const settings = deferred<ResultOf<'backgroundModel.settings'>>()
    const transport = new TestTransport(() => settings.promise)
    renderSettings({ initialSection: 'models', transport })
    const background = screen.getByRole('region', { name: 'Background work' })
    const loading = within(background).getByText('Loading background model…')
    expect(loading.closest('[role="status"]')?.getAttribute('aria-busy')).toBe('true')
    expect(loading.closest('[role="status"]')?.querySelector('.skeleton--block')).toBeTruthy()
    expect(within(background).getByText('Loading background model details…').className).toBe(
      'visually-hidden',
    )
    expect(within(background).queryByRole('combobox')).toBeNull()
    expect(within(background).queryByText('Automatic (recommended)')).toBeNull()
    expect(within(background).queryByText(/Connect a provider with an available model/)).toBeNull()
    expect(within(background).queryByText('Reasoning effort')).toBeNull()
    expect(within(background).queryByText('Speed')).toBeNull()

    await act(async () =>
      settings.resolve({
        preference: { mode: 'automatic' },
        sources: [],
        resolved: {
          provider: 'codex',
          model: 'luna',
          sourceName: 'Codex',
          automatic: true,
        },
      }),
    )
    expect(within(background).queryByText('Loading background model…')).toBeNull()
    expect(within(background).getByRole('combobox', { name: 'Background model' }).textContent).toBe(
      'Automatic (recommended)',
    )
    expect(within(background).getByText('Currently luna through Codex.')).toBeTruthy()
  })

  it('ends the background skeleton on failure without inventing a selection', async () => {
    const settings = deferred<ResultOf<'backgroundModel.settings'>>()
    renderSettings({
      initialSection: 'models',
      transport: new TestTransport(() => settings.promise),
    })
    await act(async () => settings.reject(new Error('Background settings offline')))
    const background = screen.getByRole('region', { name: 'Background work' })
    expect(within(background).queryByText('Loading background model…')).toBeNull()
    expect(within(background).getByRole('alert').textContent).toBe('Background settings offline')
    expect(within(background).queryByText('Automatic (recommended)')).toBeNull()
  })

  it('holds the app version and update verdict until native state arrives', async () => {
    const update = deferred<bridge.AppUpdateState>()
    settingsLoading.desktop = true
    vi.spyOn(bridge, 'appUpdateState').mockReturnValue(update.promise)
    renderSettings({ initialSection: 'about' })
    const version = screen.getByText('Loading app version…').closest('[aria-busy="true"]')!
    expect(version.closest('.settings-meta')).toBeTruthy()
    expect(version.querySelector('.skeleton')?.getAttribute('style')).toContain('height: 9px')
    expect(screen.getByText('Loading update status…').className).toBe('visually-hidden')
    expect(screen.queryByText(/pre-release/)).toBeNull()

    await act(async () =>
      update.resolve({
        status: 'current',
        currentVersion: '1.2.3',
      }),
    )
    expect(screen.queryByText('Loading app version…')).toBeNull()
    expect(screen.queryByText('Loading update status…')).toBeNull()
    expect(screen.getByText('Desktop · 1.2.3')).toBeTruthy()
    expect(screen.getByRole('status', { name: 'Ready · Up to date' })).toBeTruthy()
  })

  it('passes the account loading state to the profile plan slot', () => {
    const { rerenderSettings } = renderSettings({
      overrides: { initialSection: 'profile', accountLoading: true },
    })
    expect(
      screen.getByText('Loading account plan…').closest('.profile-identity__meta'),
    ).toBeTruthy()
    rerenderSettings({
      initialSection: 'profile',
      accountLoading: false,
      account: { signedIn: true, plan: 'Pro' },
    })
    expect(screen.queryByText('Loading account plan…')).toBeNull()
    expect(screen.getByText('Pro')).toBeTruthy()
  })

  it.each([true, false])(
    'does not assume diagnostics is off before IPC returns %s',
    async (enabled) => {
      const diagnostics = deferred<boolean>()
      settingsLoading.desktop = true
      vi.spyOn(bridge, 'localDiagnosticsEnabled').mockReturnValue(diagnostics.promise)
      const toggle = vi.spyOn(bridge, 'setLocalDiagnosticsEnabled').mockResolvedValue(!enabled)
      renderSettings({ initialSection: 'data' })
      const loading = screen.getByText('Loading local diagnostics…').closest('[role="status"]')!
      expect(loading.getAttribute('aria-busy')).toBe('true')
      expect(loading.classList.contains('settings__switch-skeleton')).toBe(true)
      expect(loading.querySelector('.skeleton')?.getAttribute('style')).toContain('width: 36px')
      expect(loading.querySelector('.skeleton')?.getAttribute('style')).toContain('height: 22px')
      expect(screen.queryByRole('switch', { name: 'Local diagnostics' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull()

      await act(async () => diagnostics.resolve(enabled))
      expect(screen.queryByText('Loading local diagnostics…')).toBeNull()
      expect(
        screen.getByRole('switch', { name: 'Local diagnostics' }).getAttribute('aria-checked'),
      ).toBe(String(enabled))
      expect(Boolean(screen.queryByRole('button', { name: 'Open folder' }))).toBe(enabled)
      await act(async () =>
        fireEvent.click(screen.getByRole('switch', { name: 'Local diagnostics' })),
      )
      expect(toggle).toHaveBeenCalledWith(!enabled)
      expect(
        screen.getByRole('switch', { name: 'Local diagnostics' }).getAttribute('aria-checked'),
      ).toBe(String(!enabled))
    },
  )

  it('keeps the project count pending without asserting zero projects', async () => {
    const { rerenderSettings } = renderSettings({
      initialSection: 'data',
      overrides: { projectsLoading: true },
    })
    const loading = screen.getByText('Loading project count…')
    expect(loading.className).toBe('visually-hidden')
    expect(loading.closest('[aria-busy="true"]')?.querySelector('.skeleton')).toBeTruthy()
    expect(screen.queryByText('0 projects on this machine')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reset app preferences' })).toBeTruthy()
    rerenderSettings({ projectsLoading: false, projectCount: 3 })
    expect(screen.queryByText('Loading project count…')).toBeNull()
    expect(screen.getByText('3 projects on this machine')).toBeTruthy()
    await act(async () => {})
  })

  it('fills the install terminal frame while its lazy content opens', async () => {
    const terminal = deferred<void>()
    settingsLoading.terminal = terminal.promise
    renderProviders(
      [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          installed: false,
          auth: 'unknown',
          setup: {
            installUrl: 'https://example.test/claude',
            installCommand: 'npm install -g @anthropic-ai/claude-code',
            login: 'provider',
          },
        },
      ],
      (method) =>
        method === 'providers.install' ? { terminalId: 'loading-install' } : { signedIn: false },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    const loading = (await screen.findByText('Opening terminal…')).closest('[role="status"]')!
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.classList.contains('install-terminal')).toBe(true)
    expect(loading.querySelectorAll('.skeleton-code__line')).toHaveLength(9)
    expect(loading.querySelector('.skeleton-code__gutter')).toBeNull()
    expect(screen.queryByTestId('install-terminal')).toBeNull()

    await act(async () => {
      settingsLoading.terminal = undefined
      terminal.resolve()
    })
    expect(await screen.findByTestId('install-terminal')).toBeTruthy()
    expect(screen.queryByText('Opening terminal…')).toBeNull()
  })
})

function renderProviders(
  statuses: ProviderStatus[],
  request: TestRequestResolver,
  account?: Account,
) {
  const transport = new TestTransport((method, params) =>
    method === 'providers.updates' ? { updates: [] } : request(method, params),
  )
  render(
    <ProviderSettings
      provider="codex"
      account={account}
      providerStatuses={statuses}
      transport={transport}
      onConnectionsChanged={() => {}}
      onAccountChange={() => {}}
    />,
  )
  return (loginId: string, success: boolean, error: string | null = null) =>
    act(() => transport.emit('auth.event', { provider: 'codex', loginId, success, error }))
}
function installedProvider(id: ProviderId, displayName: string): ProviderStatus {
  return { id, displayName, installed: true, auth: 'unknown' }
}
const providerRow = (name: string) => screen.getByText(name).closest<HTMLElement>('.settings__row')!
const action = (row: HTMLElement, name: string) =>
  within(row).getByRole('button', { name }) as HTMLButtonElement
describe('provider authentication states', () => {
  it('keeps loading and failure distinct from signed out, then retries', async () => {
    const status = deferred<Account>()
    let reads = 0
    renderProviders([installedProvider('codex', 'Codex')], () =>
      ++reads === 1 ? status.promise : { signedIn: true },
    )
    const row = providerRow('Codex')
    expect(within(row).getByRole('status').textContent).toContain('Checking account…')
    expect(within(row).queryByRole('button', { name: 'Sign in' })).toBeNull()
    status.reject(new Error('Codex status unavailable'))
    expect((await screen.findByRole('alert')).textContent).toContain('Codex status unavailable')
    const issue = within(row).getByRole('button', { name: 'Problem details' })
    fireEvent.focus(issue)
    expect(issue.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
    expect(within(row).queryByRole('button', { name: 'Sign in' })).toBeNull()
    fireEvent.click(action(row, 'Retry'))
    await waitFor(() =>
      expect(row.querySelector('.provider-row__status')?.textContent).toBe('Signed in'),
    )
    expect(reads).toBe(2)
  })
  it('uses one provider row grammar with honest actions and normalized marks', async () => {
    renderProviders(
      [
        { ...installedProvider('codex', 'Codex'), version: 'codex-cli 1.4.0' },
        {
          ...installedProvider('claude-code', 'Claude Code'),
          problem: 'Claude Code should be updated',
        },
        {
          id: 'grok',
          displayName: 'Grok',
          installed: false,
          auth: 'unknown',
          problem: 'grok is not on PATH',
          setup: { installUrl: 'https://x.ai/cli', login: 'provider' },
        },
      ],
      (method, params) => {
        if (method !== 'auth.status') throw new Error(`unexpected ${method}`)
        const request = methods[method].params.parse(params)
        return { signedIn: request.provider === 'codex' }
      },
    )

    const codex = providerRow('Codex')
    const claude = providerRow('Claude Code')
    const grok = providerRow('Grok')
    await waitFor(() =>
      expect(codex.querySelector('.provider-row__status')?.textContent).toBe('Signed in'),
    )
    const columns = (row: HTMLElement) => Array.from(row.children).map((child) => child.className)
    expect(columns(codex)).toEqual(columns(claude))
    expect(columns(claude)).toEqual(columns(grok))
    expect(codex.querySelector('.provider-row__mark')?.getAttribute('title')).toBe(
      'codex-cli 1.4.0',
    )
    expect(within(codex).queryByText('codex-cli 1.4.0')).toBeNull()
    for (const row of [codex, claude, grok]) {
      expect(row.querySelector('.provider-row__mark svg')?.getAttribute('width')).toBe('18')
    }
    expect(within(claude).getByRole('button', { name: 'Sign in' }).className).toContain(
      'is-primary',
    )
    const signOut = within(codex).getByRole('button', { name: 'Sign out' })
    expect(signOut.className).toContain('is-primary')
    expect(signOut.className).toContain('is-danger')
    expect(signOut.className).not.toContain('is-quiet')
    fireEvent.focus(within(claude).getByRole('button', { name: 'Problem details' }))
    expect(screen.getByRole('tooltip').textContent).toBe('Claude Code should be updated')
    expect(within(grok).getByText('Not installed')).toBeTruthy()
    expect(within(grok).queryByRole('button', { name: 'Problem details' })).toBeNull()
    expect([codex, claude, grok].map((row) => row.dataset['link'])).toEqual([
      'connected',
      'open',
      'none',
    ])
    const guide = within(grok).getByRole('link', { name: 'Open setup guide' })
    expect(guide.querySelector('svg')).toBeTruthy()
    expect(guide.getAttribute('href')).toBe('https://x.ai/cli')
    expect(guide.getAttribute('target')).toBe('_blank')
    expect(guide.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('keeps overlapping provider operations and errors independent', async () => {
    const codexStatus = deferred<Account>()
    const codexSignOut = deferred<Record<string, never>>()
    const claudeSignOut = deferred<Record<string, never>>()
    renderProviders(
      [installedProvider('codex', 'Codex'), installedProvider('claude-code', 'Claude Code')],
      (method, params) => {
        if (method === 'auth.status') {
          const { provider } = methods[method].params.parse(params)
          return provider === 'codex' ? codexStatus.promise : { signedIn: true }
        }
        const { provider } = methods['auth.signOut'].params.parse(params)
        return provider === 'codex' ? codexSignOut.promise : claudeSignOut.promise
      },
      { signedIn: true },
    )
    const codexRow = providerRow('Codex')
    const claudeRow = providerRow('Claude Code')
    await waitFor(() => action(claudeRow, 'Sign out'))
    fireEvent.click(action(codexRow, 'Sign out'))
    fireEvent.click(action(claudeRow, 'Sign out'))
    expect(action(codexRow, 'Signing out…').disabled).toBe(true)
    expect(action(claudeRow, 'Signing out…').disabled).toBe(true)
    codexSignOut.resolve({})
    await waitFor(() => action(codexRow, 'Sign in'))
    await act(async () => codexStatus.resolve({ signedIn: true }))
    expect(action(codexRow, 'Sign in')).toBeTruthy()
    expect(action(claudeRow, 'Signing out…').disabled).toBe(true)
    claudeSignOut.reject(new Error('Claude sign-out failed'))
    expect((await within(claudeRow).findByRole('alert')).textContent).toContain('sign-out failed')
    expect(action(claudeRow, 'Sign out').disabled).toBe(false)
    expect(within(codexRow).queryByRole('alert')).toBeNull()
  })
  it('recovers remounted and early events without accepting a stale attempt', async () => {
    let statusReads = 0
    let loginStarts = 0
    const firstLogin = deferred<ResultOf<'auth.startLogin'>>()
    const emitAuth = renderProviders([installedProvider('codex', 'Codex')], async (method) => {
      if (method === 'auth.status') return { signedIn: ++statusReads > 2 }
      return ++loginStarts === 1
        ? firstLogin.promise
        : { loginId: `login-${loginStarts}`, authUrl: undefined }
    })
    const row = providerRow('Codex')
    await waitFor(() => action(row, 'Sign in'))
    emitAuth('login-from-unmounted-panel', true)
    await waitFor(() => expect(statusReads).toBe(2))
    fireEvent.click(action(row, 'Sign in'))
    emitAuth('login-1', false, 'Cancelled')
    emitAuth('stale-login', true)
    await act(async () => firstLogin.resolve({ loginId: 'login-1' }))
    await waitFor(() => action(row, 'Sign in'))
    fireEvent.click(action(row, 'Sign in'))
    expect(loginStarts).toBe(2)
    emitAuth('login-1', true)
    expect(action(row, 'Signing in…').disabled).toBe(true)
    expect(statusReads).toBe(2)
    emitAuth('login-2', true)
    await waitFor(() => action(row, 'Sign out'))
    expect(statusReads).toBe(3)
  })
})

describe('app haptic setting', () => {
  it('shows only on supported desktop Macs and persists the toggle', () => {
    const unsupported = renderAppearanceSettings()
    expect(screen.queryByRole('switch', { name: 'Trackpad haptics' })).toBeNull()
    unsupported.unmount()

    writeAppHaptics(false)
    renderAppearanceSettings(true)
    const toggle = screen.getByRole('switch', { name: 'Trackpad haptics' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem(HAPTICS_KEY)).toBe('true')
  })
})

describe('model settings', () => {
  it('persists background model, effort, and speed without carrying Fast to unsupported models', async () => {
    const sources = [
      {
        id: 'codex',
        displayName: 'Codex',
        provider: 'codex' as const,
        models: [
          {
            id: 'gpt-5.6-luna',
            displayName: 'GPT-5.6 Luna',
            isDefault: false,
            reasoningEfforts: ['low', 'medium', 'high'],
            serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }],
          },
        ],
      },
      {
        id: 'grok',
        displayName: 'Grok',
        provider: 'grok' as const,
        models: [
          {
            id: 'grok-4.6',
            displayName: 'Grok 4.6',
            isDefault: true,
            reasoningEfforts: ['low'],
            serviceTiers: [],
          },
        ],
      },
    ]
    const transport = new TestTransport(async (method, params) => {
      if (method === 'backgroundModel.settings') {
        return {
          preference: { mode: 'automatic' as const },
          sources,
          resolved: {
            provider: 'codex' as const,
            model: 'gpt-5.6-luna',
            effort: 'low',
            sourceName: 'Codex',
            automatic: true,
          },
        }
      }
      if (method === 'backgroundModel.updateSettings') {
        const preference = methods[method].params.parse(params)
        const target = preference.mode === 'manual' ? preference.target : undefined
        return {
          preference,
          sources,
          ...(target
            ? {
                resolved: {
                  ...target,
                  sourceName: 'Codex',
                  automatic: false,
                },
              }
            : {}),
        }
      }
      throw new Error(`unexpected ${method}`)
    })
    renderSettings({
      initialSection: 'models',
      transport,
    })

    const picker = await screen.findByRole('combobox', { name: 'Background model' })
    expect(picker.tagName).toBe('BUTTON')
    expect(screen.getByText(/gpt-5\.6 luna through codex at low effort/i)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Background speed' })).toBeNull()
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.6 Luna' }))

    await waitFor(() =>
      expect(transport.requests).toContainEqual({
        method: 'backgroundModel.updateSettings',
        params: {
          mode: 'manual',
          target: {
            provider: 'codex',
            model: 'gpt-5.6-luna',
            effort: 'low',
          },
        },
      }),
    )
    const effort = await screen.findByRole('combobox', { name: 'Background reasoning effort' })
    expect(effort.tagName).toBe('BUTTON')
    const speed = screen.getByRole('combobox', { name: 'Background speed' })
    expect(speed.textContent).toContain('Standard')
    fireEvent.click(speed)
    fireEvent.click(screen.getByRole('option', { name: 'Fast' }))
    await waitFor(() => expect(speed.textContent).toContain('Fast'))
    expect(transport.requests.at(-1)).toEqual({
      method: 'backgroundModel.updateSettings',
      params: {
        mode: 'manual',
        target: {
          provider: 'codex',
          model: 'gpt-5.6-luna',
          effort: 'low',
          serviceTier: 'priority',
        },
      },
    })
    fireEvent.click(effort)
    fireEvent.click(screen.getByRole('option', { name: 'high' }))
    await waitFor(() =>
      expect(transport.requests).toContainEqual({
        method: 'backgroundModel.updateSettings',
        params: {
          mode: 'manual',
          target: {
            provider: 'codex',
            model: 'gpt-5.6-luna',
            effort: 'high',
            serviceTier: 'priority',
          },
        },
      }),
    )
    await waitFor(() => expect(effort.textContent).toContain('high'))
    expect(speed.textContent).toContain('Fast')
    fireEvent.click(speed)
    fireEvent.click(screen.getByRole('option', { name: 'Standard' }))
    await waitFor(() => expect(speed.textContent).toContain('Standard'))
    expect(transport.requests.at(-1)).toEqual({
      method: 'backgroundModel.updateSettings',
      params: {
        mode: 'manual',
        target: {
          provider: 'codex',
          model: 'gpt-5.6-luna',
          effort: 'high',
          serviceTier: undefined,
        },
      },
    })
    fireEvent.click(speed)
    fireEvent.click(screen.getByRole('option', { name: 'Fast' }))
    await waitFor(() => expect(speed.textContent).toContain('Fast'))
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('option', { name: 'Grok 4.6' }))
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Background speed' })).toBeNull(),
    )
    expect(transport.requests.at(-1)).toEqual({
      method: 'backgroundModel.updateSettings',
      params: {
        mode: 'manual',
        target: { provider: 'grok', model: 'grok-4.6', effort: 'low' },
      },
    })
  })

  it('keeps a disconnected manual choice visible so Automatic can replace it', async () => {
    const transport = new TestTransport(async (method, params) => {
      if (method === 'backgroundModel.settings') {
        return {
          preference: {
            mode: 'manual' as const,
            target: { provider: 'grok' as const, model: 'grok-code-fast-1', effort: 'low' },
          },
          sources: [],
        }
      }
      if (method === 'backgroundModel.updateSettings') {
        return { preference: methods[method].params.parse(params), sources: [] }
      }
      throw new Error(`unexpected ${method}`)
    })
    renderSettings({
      initialSection: 'models',
      transport,
    })

    const picker = await screen.findByRole('combobox', { name: 'Background model' })
    expect(picker.textContent).toContain('grok-code-fast-1 (unavailable)')
    expect(screen.getByText(/grok-code-fast-1 is unavailable/i)).toBeTruthy()
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('option', { name: 'Automatic (recommended)' }))

    await waitFor(() =>
      expect(transport.requests).toContainEqual({
        method: 'backgroundModel.updateSettings',
        params: { mode: 'automatic' },
      }),
    )
  })

  it('uses All and None buttons to change every model for one provider', () => {
    const models: ModelChoice[] = [
      {
        key: 'grok:ling',
        provider: 'grok',
        sourceName: 'Grok',
        mark: 'grok',
        model: {
          id: 'zen/ling-3.0-tiny',
          displayName: 'Grok 4.6 Fast',
          description: '',
          isDefault: false,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      },
      {
        key: 'grok:qwen',
        provider: 'grok',
        sourceName: 'Grok',
        mark: 'grok',
        model: {
          id: 'go/qwen3.8-max',
          displayName: 'Grok Code Max',
          description: '',
          isDefault: false,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      },
    ]
    const onModelVisibilityChange = vi.fn()
    const transport = new TestTransport()

    const settings = (hiddenModels: Set<string>) => (
      <Settings
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[]}
        models={models}
        hiddenModels={hiddenModels}
        onModelVisibilityChange={onModelVisibilityChange}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themeColorScheme="dark"
        themePreference="system"
        onThemePreferenceChange={() => {}}
        appearancePreferences={{
          light: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
          dark: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
        }}
        onAppearancePreferenceChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const view = render(settings(new Set(['grok:ling'])))

    const categories = screen.getByRole('navigation', { name: 'Settings categories' })
    expect(within(categories).getAllByRole('button')[0]?.textContent).toBe('General')

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    const sourceHeading = screen.getByText('Grok').closest('.source-identity')
    expect(sourceHeading?.getAttribute('title')).toBe('Grok')
    expect(sourceHeading?.querySelector('svg')?.getAttribute('width')).toBe('15')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByText('Grok 4.6 Fast')).toBeTruthy()
    const allButton = screen.getByRole('button', {
      name: 'Show all Grok models in model picker',
    })
    const noneButton = screen.getByRole('button', {
      name: 'Hide all Grok models from model picker',
    })
    const ling = screen.getByRole('switch', {
      name: 'Include Grok 4.6 Fast in model picker',
    })
    const qwen = screen.getByRole('switch', {
      name: 'Include Grok Code Max in model picker',
    })
    expect(allButton.textContent).toBe('All')
    expect(noneButton.textContent).toBe('None')
    expect((allButton as HTMLButtonElement).disabled).toBe(false)
    expect((noneButton as HTMLButtonElement).disabled).toBe(false)
    expect(
      screen.queryByRole('switch', {
        name: 'Include models from Grok in model picker',
      }),
    ).toBeNull()
    expect(ling.getAttribute('aria-checked')).toBe('false')
    expect(qwen.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(allButton)
    expect(onModelVisibilityChange).toHaveBeenCalledOnce()
    expect(onModelVisibilityChange).toHaveBeenCalledWith('grok:ling', true)

    onModelVisibilityChange.mockClear()
    view.rerender(settings(new Set()))
    const disabledAllButton = screen.getByRole('button', {
      name: 'Show all Grok models in model picker',
    })
    const enabledNoneButton = screen.getByRole('button', {
      name: 'Hide all Grok models from model picker',
    })
    expect((disabledAllButton as HTMLButtonElement).disabled).toBe(true)
    expect((enabledNoneButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(enabledNoneButton)
    expect(onModelVisibilityChange).toHaveBeenCalledTimes(2)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(1, 'grok:ling', false)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(2, 'grok:qwen', false)

    onModelVisibilityChange.mockClear()
    view.rerender(settings(new Set(['grok:ling', 'grok:qwen'])))
    const enabledAllButton = screen.getByRole('button', {
      name: 'Show all Grok models in model picker',
    })
    const disabledNoneButton = screen.getByRole('button', {
      name: 'Hide all Grok models from model picker',
    })
    expect((enabledAllButton as HTMLButtonElement).disabled).toBe(false)
    expect((disabledNoneButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(enabledAllButton)
    expect(onModelVisibilityChange).toHaveBeenCalledTimes(2)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(1, 'grok:ling', true)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(2, 'grok:qwen', true)

    onModelVisibilityChange.mockClear()
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Include Grok 4.6 Fast in model picker',
      }),
    )
    expect(onModelVisibilityChange).toHaveBeenCalledWith('grok:ling', true)
    expect(screen.getByText('Grok Code Max')).toBeTruthy()
  })

  it('omits stored custom-model management from beta settings', () => {
    const custom = customModelChoice({
      provider: 'codex',
      modelId: 'qwen-max',
      displayName: 'Qwen Max',
    })
    const onCustomModelAdd = vi.fn()
    const onCustomModelRemove = vi.fn()
    const transport = new TestTransport()

    render(
      <Settings
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[]}
        models={[custom]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themeColorScheme="dark"
        themePreference="system"
        onThemePreferenceChange={() => {}}
        appearancePreferences={{
          light: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
          dark: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
        }}
        onAppearancePreferenceChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))

    expect(screen.queryByRole('region', { name: 'Custom models' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add custom model' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Show Qwen Max' })).toBeNull()
    expect(onCustomModelAdd).not.toHaveBeenCalled()
    expect(onCustomModelRemove).not.toHaveBeenCalled()
  })

  it('does not offer raw custom ids from a provider list', () => {
    const models: ModelChoice[] = [
      {
        key: 'grok:ling',
        provider: 'grok',
        sourceName: 'Grok',
        mark: 'grok',
        model: {
          id: 'zen/ling-3.0-tiny',
          displayName: 'Grok 4.6 Fast',
          description: '',
          isDefault: false,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      },
    ]
    const onCustomModelAdd = vi.fn()
    const transport = new TestTransport()

    render(
      <Settings
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[]}
        models={models}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themeColorScheme="dark"
        themePreference="system"
        onThemePreferenceChange={() => {}}
        appearancePreferences={{
          light: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
          dark: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
        }}
        onAppearancePreferenceChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    const group = screen.getByRole('region', { name: 'Grok' })
    expect(within(group).queryByRole('button', { name: 'Add custom model' })).toBeNull()
    expect(onCustomModelAdd).not.toHaveBeenCalled()
  })
})

describe('provider settings', () => {
  it('keeps custom harness controls out of the public beta', () => {
    renderProviders([], () => {
      throw new Error('unexpected request')
    })

    expect(screen.queryByText('Custom harnesses')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add custom harness' })).toBeNull()
  })

  it('shows a plan without an email when the provider exposes it', async () => {
    renderProviders([installedProvider('claude-code', 'Claude Code')], (method) => {
      if (method === 'auth.status') return { signedIn: true, plan: 'Pro' }
      throw new Error(`unexpected ${method}`)
    })
    await waitFor(() =>
      expect(providerRow('Claude Code').querySelector('.provider-row__status')?.textContent).toBe(
        'Signed in · Pro',
      ),
    )
  })

  it('shows an honest signed-in fallback instead of asking for an email', async () => {
    renderProviders([installedProvider('grok', 'Grok')], (method) => {
      if (method === 'auth.status') return { signedIn: true }
      if (method === 'auth.signOut') return {}
      throw new Error(`unexpected ${method}`)
    })

    const grok = providerRow('Grok')
    await waitFor(() =>
      expect(grok.querySelector('.provider-row__status')?.textContent).toBe('Signed in'),
    )
    expect(within(grok).queryByRole('button', { name: 'Add email' })).toBeNull()

    fireEvent.click(within(grok).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(localStorage.getItem('harness.providerEmail.grok')).toBeNull())
  })

  it('shows one account action per provider and runs that provider flow', async () => {
    const accounts = {
      codex: { signedIn: true, email: 'private@example.com', plan: 'pro' },
      'claude-code': { signedIn: true, email: 'claude@example.com', plan: 'pro' },
      grok: { signedIn: false },
    } satisfies Partial<Record<ProviderId, Account>>
    const accountFor = (provider: ProviderId): Account | undefined => {
      if (provider === 'codex') return accounts.codex
      if (provider === 'claude-code') return accounts['claude-code']
      if (provider === 'grok') return accounts.grok
      return undefined
    }
    const transport = new TestTransport(async (method, params) => {
      if (method === 'auth.status') {
        const request = methods[method].params.parse(params)
        return accountFor(request.provider)
      }
      if (method === 'auth.startLogin') {
        return { loginId: 'login-1', authUrl: 'https://auth.example.test/' }
      }
      if (method === 'auth.signOut') return {}
      if (method === 'providers.install') return { terminalId: 'term-install-1' }
      throw new Error(`unexpected ${method}`)
    })
    const onAccountChange = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    render(
      <Settings
        initialSection="providers"
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={accounts.codex}
        providerStatuses={[
          { id: 'codex', displayName: 'Codex', installed: true, auth: 'authenticated' },
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            installed: true,
            auth: 'authenticated',
          },
          {
            id: 'grok',
            displayName: 'Grok',
            installed: true,
            auth: 'unauthenticated',
            setup: { installUrl: 'https://example.test/grok', login: 'provider' },
          },
        ]}
        models={[]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themeColorScheme="dark"
        themePreference="system"
        onThemePreferenceChange={() => {}}
        appearancePreferences={{
          light: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
          dark: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
        }}
        onAppearancePreferenceChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={onAccountChange}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(2))
    expect(screen.getAllByText('Codex')).toHaveLength(1)

    const codexRow = screen.getByText('Codex').closest<HTMLElement>('.settings__row')
    if (!codexRow) throw new Error('Codex provider row missing')
    const email = within(codexRow).getByText('private@example.com', {
      selector: '.settings__email-value',
    })
    expect(email.className).toBe('settings__email-value')
    const emailControl = email.closest<HTMLElement>('.settings__email')
    if (!emailControl) throw new Error('redacted email control missing')
    const emailButton = within(emailControl).getByRole('button', { name: 'Show account email' })
    expect(emailButton.getAttribute('title')).toBe('Hover to preview or click to keep visible')
    expect(emailControl.getAttribute('data-revealed')).toBe('false')
    expect(emailControl.getAttribute('data-pinned')).toBe('false')

    fireEvent.pointerEnter(emailButton, { pointerType: 'mouse' })
    expect(emailControl.getAttribute('data-revealed')).toBe('true')
    expect(emailButton.querySelector('.settings__email-eye--hide')).toBeTruthy()
    fireEvent.pointerLeave(emailButton)
    expect(emailControl.getAttribute('data-revealed')).toBe('false')

    fireEvent.pointerEnter(emailButton, { pointerType: 'mouse' })
    fireEvent.click(emailButton)
    expect(emailControl.getAttribute('data-revealed')).toBe('true')
    expect(emailControl.getAttribute('data-pinned')).toBe('true')
    expect(emailButton.getAttribute('title')).toBe('Click to hide email')
    fireEvent.pointerLeave(emailButton)
    expect(emailControl.getAttribute('data-revealed')).toBe('true')
    fireEvent.click(emailButton)
    expect(emailControl.getAttribute('data-revealed')).toBe('false')
    expect(emailControl.getAttribute('data-pinned')).toBe('false')
    expect(within(codexRow).queryByText(/\*+@example\.com/)).toBeNull()

    // API connections do not exist on main.
    expect(screen.queryByRole('button', { name: 'Connect another plan or API' })).toBeNull()

    const claudeRow = screen.getByText('Claude Code').closest<HTMLElement>('.settings__row')
    const grokRow = screen.getByText('Grok').closest<HTMLElement>('.settings__row')
    expect(claudeRow?.querySelector('.provider-row__status')?.textContent).toBe(
      'claude@example.com · pro',
    )
    if (!claudeRow || !grokRow) throw new Error('provider row missing')
    fireEvent.click(within(claudeRow).getByRole('button', { name: 'Sign out' }))
    await waitFor(() =>
      expect(transport.requests).toContainEqual({
        method: 'auth.signOut',
        params: { provider: 'claude-code' },
      }),
    )

    // Grok signs in through its own CLI: the row offers the guided card flow.
    expect(within(grokRow).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })

  it('runs installs in the background and refreshes once the install exits cleanly', async () => {
    const transport = new TestTransport(async (method) => {
      if (method === 'providers.install') return { terminalId: 'term-install-2' }
      if (method === 'auth.status') return { signedIn: false }
      throw new Error(`unexpected ${method}`)
    })
    const onConnectionsChanged = vi.fn()

    const settingsFor = (onChanged: () => void) => (
      <Settings
        initialSection="providers"
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            installed: false,
            auth: 'unknown',
            setup: {
              installUrl: 'https://example.test/claude',
              installCommand: 'npm install -g @anthropic-ai/claude-code',
              login: 'provider',
            },
          },
        ]}
        models={[]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={onChanged}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themeColorScheme="dark"
        themePreference="system"
        onThemePreferenceChange={() => {}}
        appearancePreferences={{
          light: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
          dark: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
        }}
        onAppearancePreferenceChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const view = render(settingsFor(onConnectionsChanged))

    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() =>
      expect(transport.requests).toContainEqual({
        method: 'providers.install',
        params: { provider: 'claude-code', columns: 100, rows: 30 },
      }),
    )

    transport.emit('terminal.output', {
      terminalId: 'term-install-2',
      data: 'added 12 packages\r\n',
    })
    const installRow = providerRow('Claude Code')
    expect(within(installRow).getByRole('status').textContent).toContain('Installing…')
    expect(screen.queryByText('added 12 packages')).toBeNull()
    const details = within(installRow).getByRole('button', { name: 'Details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByTestId('install-terminal')).toBeTruthy()
    details.focus()

    transport.emit('terminal.exit', { terminalId: 'term-install-2', exitCode: 0 })
    await waitFor(() => expect(onConnectionsChanged).toHaveBeenCalled())
    const successDetails = within(installRow).getByRole('button', { name: 'Hide details' })
    expect(successDetails.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('install-terminal')).toBeTruthy()
    expect(document.activeElement).toBe(successDetails)

    // The succeeded row persists until the provider list confirms the
    // install, and parents may hand the callback a fresh identity on every
    // render. That combination once produced an endless refresh loop that
    // spawned an `opencode serve` process per iteration — the notification
    // must stay one-shot no matter how often the row re-renders.
    view.rerender(settingsFor(() => onConnectionsChanged()))
    view.rerender(settingsFor(() => onConnectionsChanged()))
    expect(screen.getByRole('button', { name: 'Installed' })).toBeTruthy()
    expect(onConnectionsChanged).toHaveBeenCalledTimes(1)
  })

  it('hands provider installs to the expanded workspace terminal', async () => {
    const transport = new TestTransport(async (method) => {
      if (method === 'providers.install') return { terminalId: 'term-codex-install' }
      throw new Error(`unexpected ${method}`)
    })
    const onProviderLoginTerminalOpen = vi.fn()

    render(
      <ProviderSettings
        provider="codex"
        account={undefined}
        providerStatuses={[
          {
            id: 'codex',
            displayName: 'Codex',
            installed: false,
            auth: 'unknown',
            setup: {
              installUrl: 'https://developers.openai.com/codex/cli',
              installCommand: 'npm install -g @openai/codex',
              login: 'provider',
            },
          },
        ]}
        transport={transport}
        onConnectionsChanged={() => {}}
        onAccountChange={() => {}}
        onProviderLoginTerminalOpen={onProviderLoginTerminalOpen}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() =>
      expect(onProviderLoginTerminalOpen).toHaveBeenCalledWith({
        provider: 'codex',
        displayName: 'Codex',
        installKey: 'codex',
        operation: 'install',
      }),
    )
    expect(transport.requests).toContainEqual({
      method: 'providers.install',
      params: { provider: 'codex', columns: 100, rows: 30 },
    })
  })

  it('signs in to provider-CLI-managed logins in an in-app terminal, not a docs page', async () => {
    let signedIn = false
    const transport = new TestTransport(async (method) => {
      if (method === 'providers.launch') return { terminalId: 'term-login-3' }
      if (method === 'auth.status') return { signedIn }
      throw new Error(`unexpected ${method}`)
    })
    const onConnectionsChanged = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    render(
      <Settings
        initialSection="providers"
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[
          {
            id: 'grok',
            displayName: 'Grok',
            installed: true,
            auth: 'unknown',
            setup: {
              installUrl: 'https://example.test/grok',
              login: 'provider',
            },
          },
        ]}
        models={[]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={onConnectionsChanged}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themeColorScheme="dark"
        themePreference="system"
        onThemePreferenceChange={() => {}}
        appearancePreferences={{
          light: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
          dark: { font: 'geist', accent: 'neutral', backdrop: 'default', glass: 0 },
        }}
        onAppearancePreferenceChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy())
    const grokRow = screen.getByText('Grok').closest<HTMLElement>('.settings__row')
    if (!grokRow) throw new Error('Grok row missing')
    fireEvent.click(within(grokRow).getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(transport.requests).toContainEqual({
        method: 'providers.launch',
        params: { provider: 'grok', columns: 320, rows: 30 },
      }),
    )
    expect(open).not.toHaveBeenCalled()
    // The guided card leads; the raw terminal waits behind Details.
    await waitFor(() => expect(screen.getByText('Starting the provider sign-in…')).toBeTruthy())
    expect(screen.queryByTestId('install-terminal')).toBeNull()

    transport.emit('terminal.output', {
      terminalId: 'term-login-3',
      data: 'Visit https://example.test/device then enter code: WDJB-MJHT \r\n',
    })
    // The OAuth link opens once by itself; the code becomes a copyable chip.
    await waitFor(() => expect(screen.getByText('WDJB-MJHT')).toBeTruthy())
    expect(open).toHaveBeenCalledWith(
      'https://example.test/device',
      '_blank',
      'noopener,noreferrer',
    )
    expect(screen.getByRole('button', { name: 'Open link again' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    await waitFor(() => expect(screen.getByTestId('install-terminal')).toBeTruthy())

    transport.emit('terminal.output', {
      terminalId: 'term-login-3',
      data: '\u001b[32m✓ Signed in as grok.user@example.com\u001b[0m\r\n',
    })
    await waitFor(() =>
      expect(localStorage.getItem('harness.providerEmail.grok')).toBe('grok.user@example.com'),
    )
    signedIn = true
    transport.emit('terminal.exit', { terminalId: 'term-login-3', exitCode: 0 })
    await waitFor(() => expect(screen.queryByTestId('install-terminal')).toBeNull())
    await waitFor(() => expect(providerRow('Grok').textContent).toContain('grok.user@example.com'))

    expect(open).toHaveBeenCalledTimes(1)
    expect(onConnectionsChanged).not.toHaveBeenCalled()
  })

  it('closes failed details and lets Settings cancel a new sign-in', async () => {
    let attempt = 0
    const transport = new TestTransport(async (method) => {
      if (method === 'auth.status') return { signedIn: false }
      if (method === 'providers.launch') return { terminalId: `settings-login-${++attempt}` }
      if (method === 'terminal.close') return {}
      throw new Error(`unexpected ${method}`)
    })
    render(
      <ProviderSettings
        provider="claude-code"
        account={{ signedIn: false }}
        providerStatuses={[
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            installed: true,
            auth: 'unknown',
            setup: { installUrl: 'https://example.test', login: 'provider' },
          },
        ]}
        transport={transport}
        onConnectionsChanged={() => {}}
        onAccountChange={() => {}}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    await screen.findByTestId('install-terminal')
    act(() => transport.emit('terminal.exit', { terminalId: 'settings-login-1', exitCode: 130 }))
    await screen.findByRole('button', { name: 'Retry sign-in' })
    expect(screen.queryByTestId('install-terminal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry sign-in' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }))
    await screen.findByText('Sign-in canceled')
    expect(transport.requests).toContainEqual({
      method: 'terminal.close',
      params: { terminalId: 'settings-login-2' },
    })
    expect(screen.queryByText('Sign-in failed')).toBeNull()
    expect(screen.queryByTestId('install-terminal')).toBeNull()
  })

  it('does not open the terminal when a pending sign-in is canceled', async () => {
    let launch!: (value: { terminalId: string }) => void
    const transport = new TestTransport(async (method) => {
      if (method === 'auth.status') return { signedIn: false }
      if (method === 'providers.launch')
        return new Promise((resolve) => {
          launch = resolve
        })
      if (method === 'terminal.close') return {}
      throw new Error(`unexpected ${method}`)
    })
    const open = vi.fn()
    render(
      <ProviderSettings
        provider="claude-code"
        account={{ signedIn: false }}
        providerStatuses={[
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            installed: true,
            auth: 'unknown',
            setup: { installUrl: 'https://example.test', login: 'provider' },
          },
        ]}
        transport={transport}
        onConnectionsChanged={() => {}}
        onAccountChange={() => {}}
        onProviderLoginTerminalOpen={open}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }))
    await act(async () => launch({ terminalId: 'pending-login' }))
    await screen.findByText('Sign-in canceled')
    expect(open).not.toHaveBeenCalled()
    expect(transport.requests).toContainEqual({
      method: 'terminal.close',
      params: { terminalId: 'pending-login' },
    })
  })

  it('hands every provider CLI login to the expanded workspace terminal', async () => {
    const transport = new TestTransport(async (method) => {
      if (method === 'auth.status') return { signedIn: false }
      if (method === 'providers.launch') return { terminalId: 'term-grok-login' }
      throw new Error(`unexpected ${method}`)
    })
    const onProviderLoginTerminalOpen = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    render(
      <ProviderSettings
        provider="codex"
        account={undefined}
        providerStatuses={[
          {
            id: 'grok',
            displayName: 'Grok',
            installed: true,
            auth: 'unknown',
            setup: {
              installUrl: 'https://x.ai/cli',
              login: 'provider',
              loginOpensBrowser: false,
            },
          },
        ]}
        transport={transport}
        onConnectionsChanged={() => {}}
        onAccountChange={() => {}}
        onProviderLoginTerminalOpen={onProviderLoginTerminalOpen}
      />,
    )

    const signIn = await screen.findByRole('button', { name: 'Sign in' })
    fireEvent.click(signIn)

    await waitFor(() =>
      expect(onProviderLoginTerminalOpen).toHaveBeenCalledWith({
        provider: 'grok',
        displayName: 'Grok',
        installKey: 'login:grok',
      }),
    )
    expect(transport.requests).toContainEqual({
      method: 'providers.launch',
      params: { provider: 'grok', columns: 320, rows: 30 },
    })
    transport.emit('terminal.output', {
      terminalId: 'term-grok-login',
      data: 'If the browser did not open, visit https://grok.example.test/oauth\r\n',
    })
    expect(open).toHaveBeenCalledWith(
      'https://grok.example.test/oauth',
      '_blank',
      'noopener,noreferrer',
    )
    expect(screen.queryByTestId('install-terminal')).toBeNull()
  })
})

describe('provider defaults', () => {
  const codex: ProviderStatus = {
    id: 'codex',
    displayName: 'Codex',
    installed: true,
    auth: 'unknown',
    capabilities: {
      steer: true,
      fork: true,
      interrupt: true,
      reasoningItems: true,
      approvals: true,
      images: true,
      autoReview: true,
      context: {
        windows: [272_000, 872_000],
        compaction: true,
        compactionOff: false,
        defaultCompactAt: 90,
        latestCompactAt: 90,
      },
    },
  }
  const codexModels = [
    { id: 'gpt-6', displayName: 'GPT-6' },
    { id: 'gpt-5.5', displayName: 'GPT-5.5' },
    { id: 'gpt-5.4', displayName: 'GPT-5.4' },
  ].map((model): ModelChoice => ({
    key: `codex:${model.id}`,
    provider: 'codex',
    sourceName: 'Codex',
    mark: 'openai',
    model: { ...model, isDefault: false, reasoningEfforts: [], serviceTiers: [] },
  }))

  it('hangs new-chat defaults off signed-in providers and reports changes per provider', async () => {
    const transport = new TestTransport(async (method, params) => {
      if (method === 'auth.status') {
        return { signedIn: (params as { provider: ProviderId }).provider === 'codex' }
      }
      if (method === 'providers.contextSettings') return { codex: { compactAt: 70 } }
      throw new Error(`unexpected ${method}`)
    })
    const onPinChange = vi.fn()
    const onAccessChange = vi.fn()

    render(
      <ProviderSettings
        provider="codex"
        account={undefined}
        providerStatuses={[codex, installedProvider('grok', 'Grok')]}
        transport={transport}
        models={codexModels}
        hiddenModels={new Set(['codex:gpt-5.4'])}
        providerDefaults={{
          pins: { codex: { model: 'gpt-6' } },
          onPinChange,
          access: { codex: 'auto' },
          onAccessChange,
        }}
        onConnectionsChanged={() => {}}
        onAccountChange={() => {}}
      />,
    )

    const defaults = await screen.findByRole('group', { name: 'Codex defaults' })
    expect(screen.queryByRole('group', { name: 'Grok defaults' })).toBeNull()
    await waitFor(() =>
      expect(within(defaults).getByRole('button', { name: /^Codex context: / }).textContent).toBe(
        'Compacts at 70%',
      ),
    )

    const model = within(defaults).getByRole('button', { name: /^Codex default model: / })
    expect(model.textContent).toBe('GPT-6')
    fireEvent.click(model)
    const models = screen.getByRole('dialog', { name: 'Codex default model' })
    expect(
      within(models)
        .getAllByRole('button')
        .map((choice) => choice.getAttribute('aria-label')),
    ).toEqual(['Last used', 'GPT-6', 'GPT-5.5'])
    fireEvent.click(within(models).getByRole('button', { name: 'Last used' }))
    expect(onPinChange).toHaveBeenCalledWith('codex', undefined)

    const access = within(defaults).getByRole('button', { name: /^Codex default access: / })
    expect(access.textContent).toBe('Auto')
    fireEvent.click(access)
    const modes = screen.getByRole('menu', { name: 'Codex default access' })
    expect(
      within(modes)
        .getByRole('menuitemradio', { name: /^Auto-approve/ })
        .getAttribute('aria-checked'),
    ).toBe('true')
    fireEvent.click(within(modes).getByRole('menuitemradio', { name: /^Ask first/ }))
    expect(onAccessChange).toHaveBeenCalledWith('codex', 'ask')
  })

  function renderRoster(
    props: { providerStatuses: ProviderStatus[]; providersLoading?: boolean },
    readAccount: (provider: ProviderId) => Account | Promise<Account> = () => ({
      signedIn: true,
    }),
  ) {
    const transport = new TestTransport(async (method, params) => {
      if (method === 'auth.status')
        return readAccount((params as { provider: ProviderId }).provider)
      if (method === 'providers.contextSettings') return {}
      throw new Error(`unexpected ${method}`)
    })
    const view = (next: typeof props) => (
      <ProviderSettings
        provider="codex"
        account={undefined}
        {...next}
        transport={transport}
        models={codexModels}
        providerDefaults={{ pins: {}, onPinChange: vi.fn(), access: {}, onAccessChange: vi.fn() }}
        onConnectionsChanged={() => {}}
        onAccountChange={() => {}}
      />
    )
    const rendered = render(view(props))
    return { rerender: (next: typeof props) => rendered.rerender(view(next)) }
  }

  it('holds the defaults in place while an account is checked, but not for a signed-out one', async () => {
    const account = deferred<Account>()
    renderRoster(
      {
        providerStatuses: [
          codex,
          { ...installedProvider('grok', 'Grok'), auth: 'unauthenticated' as const },
        ],
      },
      (provider) => (provider === 'codex' ? account.promise : new Promise<Account>(() => {})),
    )

    const defaults = screen.getByRole('group', { name: 'Codex defaults' })
    expect(defaults.getAttribute('aria-busy')).toBe('true')
    expect(within(defaults).queryByRole('button')).toBeNull()
    expect(defaults.querySelectorAll('.tune-skeleton')).toHaveLength(3)
    expect(screen.queryByRole('group', { name: 'Grok defaults' })).toBeNull()

    await act(async () => account.resolve({ signedIn: true }))
    // The same rows fill in rather than being replaced.
    expect(screen.getByRole('group', { name: 'Codex defaults' })).toBe(defaults)
    expect(
      within(defaults).getByRole('button', { name: /^Codex default model: / }).textContent,
    ).toBe('Last used')
    expect(defaults.querySelector('.tune-skeleton')).toBeNull()
    expect(defaults.hasAttribute('aria-busy')).toBe(false)
  })

  it('drops the held defaults when the account turns out signed out', async () => {
    renderRoster({ providerStatuses: [codex] }, () => ({ signedIn: false }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Codex defaults' })).toBeNull())
    expect(action(providerRow('Codex'), 'Sign in')).toBeTruthy()
  })

  it('shows the roster as a skeleton until the provider list arrives', async () => {
    const { rerender } = renderRoster({ providerStatuses: [], providersLoading: true })
    const loading = screen.getByText('Loading providers…').closest('[role="status"]')!
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.querySelectorAll('.provider-row--skeleton')).toHaveLength(3)
    expect(loading.querySelectorAll('.provider-tune')).toHaveLength(3)

    rerender({ providerStatuses: [codex], providersLoading: false })
    expect(screen.queryByText('Loading providers…')).toBeNull()
    expect(await screen.findByRole('group', { name: 'Codex defaults' })).toBeTruthy()
  })
})
