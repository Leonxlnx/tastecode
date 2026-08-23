// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { methods, type Account, type ProviderId, type ResultOf } from '@harness/contracts'
import { customModelChoice, type ModelChoice } from '../model-catalog.js'
import { MODEL_PICKER_LAYOUT_KEY, writeModelPickerLayout } from '../model-picker-layout.js'
import { resetInstalls } from '../provider-install.js'
import { HAPTICS_KEY, writeAppHaptics } from '../haptics.js'
import { TERMINAL_PLACEMENT_KEY, writeTerminalPlacement } from '../terminal-placement.js'
import type { Transport } from '../transport.js'
import { TestTransport, type TestRequestResolver } from '../test-transport.js'
import { ProviderSettings, Settings } from './Settings.js'
import { createDefaultKeybindings, type KeybindingId, type Shortcut } from '../shortcuts.js'

type ProviderStatus = ResultOf<'providers.list'>['providers'][number]

vi.mock('./InstallTerminal.js', () => ({
  InstallTerminal: (props: { installKey: string }) => (
    <div data-testid="install-terminal" data-install-key={props.installKey} />
  ),
}))

function renderSettings(
  options: {
    initialSection?: 'workflows' | 'appearance' | 'models' | 'keybinds' | 'data' | 'about'
    onClose?: () => void
    onReset?: () => void
    transport?: Transport
    showMacOSHaptics?: boolean
    onKeybindingChange?: (action: KeybindingId, shortcut: Shortcut | null) => void
    onKeybindingsReset?: () => void
  } = {},
) {
  const transport = options.transport ?? new TestTransport()

  return render(
    <Settings
      provider="codex"
      providerName="Codex"
      transport={transport}
      projectPath={undefined}
      projectName={undefined}
      account={undefined}
      providerStatuses={[]}
      acpAgents={[]}
      modelConnections={[]}
      models={[]}
      hiddenModels={new Set()}
      onModelVisibilityChange={() => {}}
      onConnectionsChanged={() => {}}
      projectCount={0}
      sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
      onSidebarSettingsChange={() => {}}
      themePreference="system"
      onThemePreferenceChange={() => {}}
      fontPreference="geist"
      onFontPreferenceChange={() => {}}
      accentPreference="neutral"
      onAccentPreferenceChange={() => {}}
      backdropPreference="default"
      onBackdropPreferenceChange={() => {}}
      sidebarGlass={0}
      onSidebarGlassChange={() => {}}
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
      onReset={options.onReset ?? (() => {})}
      onClose={options.onClose ?? (() => {})}
    />,
  )
}

function renderAppearanceSettings(showMacOSHaptics = false) {
  return renderSettings({ showMacOSHaptics })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetInstalls()
  writeModelPickerLayout('list')
  localStorage.removeItem(MODEL_PICKER_LAYOUT_KEY)
  writeAppHaptics(true)
  localStorage.removeItem(HAPTICS_KEY)
  writeTerminalPlacement('bottom')
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
    expect(screen.getByRole('switch', { name: 'Provider rail layout' })).toBeTruthy()
    expect(
      screen.getByRole('combobox', { name: 'Default terminal location' }).textContent,
    ).toContain('Bottom panel')

    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(screen.queryByRole('switch', { name: 'Provider rail layout' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }))
    expect(screen.getByRole('heading', { name: 'Data & privacy' })).toBeTruthy()
  })

  it('lets the terminal shortcut target the right sidebar', () => {
    renderSettings({ initialSection: 'workflows' })

    fireEvent.click(screen.getByRole('combobox', { name: 'Default terminal location' }))
    fireEvent.click(screen.getByRole('option', { name: 'Right sidebar' }))

    expect(localStorage.getItem(TERMINAL_PLACEMENT_KEY)).toBe('workspace')
    expect(
      screen.getByRole('combobox', { name: 'Default terminal location' }).textContent,
    ).toContain('Right sidebar')
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

    expect(screen.getByText('Browser · pre-release').className).toBe('settings-meta')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(screen.getByRole('status', { name: 'Checking' }).className).toContain('is-checking')

    await act(async () => update.resolve(result))

    expect((await screen.findByRole('status', { name: label })).className).toContain(`is-${state}`)
    expect(transport.requests).toContainEqual({ method: 'system.updateCheck', params: {} })
    expect(container.querySelector('.settings__status')).toBeNull()
  })
})

describe('model picker layout setting', () => {
  it('reflects changes from the shared layout preference', () => {
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    const toggle = screen.getByRole('switch', { name: 'Provider rail layout' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    act(() => writeModelPickerLayout('rail'))

    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})

describe('settings dialog keyboard behavior', () => {
  it('contains forward and reverse Tab navigation inside the dialog', () => {
    renderSettings()
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    const first = screen.getByRole('button', { name: 'Back to app' })
    const last = screen.getByRole('button', { name: 'Lavender' })

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
    const nestedControl = screen.getByRole('button', { name: 'Lavender' })
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

function renderProviders(
  statuses: ProviderStatus[],
  request: TestRequestResolver,
  account?: Account,
) {
  const transport = new TestTransport(request)
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
    expect(issue.getAttribute('aria-describedby')).toBe(within(row).getByRole('tooltip').id)
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
    expect(signOut.className).toContain('is-secondary')
    expect(signOut.className).toContain('is-danger')
    expect(signOut.className).not.toContain('is-quiet')
    expect(within(claude).getByRole('tooltip').textContent).toBe('Claude Code should be updated')
    expect(within(grok).getByText('Not installed')).toBeTruthy()
    expect(within(grok).queryByRole('button', { name: 'Problem details' })).toBeNull()
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
  it('shows the automatic Luna policy and persists a manual model and effort', async () => {
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
          },
        },
      }),
    )
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
        key: 'opencode:ling',
        provider: 'opencode',
        sourceName: 'OpenCode',
        mark: 'opencode',
        model: {
          id: 'zen/ling-3.0-tiny',
          displayName: 'OpenCode Zen · Ling-3.0-tiny Free',
          description: '',
          isDefault: false,
          reasoningEfforts: [],
          serviceTiers: [],
        },
      },
      {
        key: 'opencode:qwen',
        provider: 'opencode',
        sourceName: 'OpenCode',
        mark: 'opencode',
        model: {
          id: 'go/qwen3.8-max',
          displayName: 'OpenCode Go · Qwen3.8 Max',
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
        acpAgents={[]}
        modelConnections={[]}
        models={models}
        hiddenModels={hiddenModels}
        onModelVisibilityChange={onModelVisibilityChange}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const view = render(settings(new Set(['opencode:ling'])))

    const categories = screen.getByRole('navigation', { name: 'Settings categories' })
    expect(within(categories).getAllByRole('button')[0]?.textContent).toBe('General')

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    const sourceHeading = screen.getByText('OpenCode').closest('.source-identity')
    expect(sourceHeading?.getAttribute('title')).toBe('OpenCode')
    expect(sourceHeading?.querySelector('svg')?.getAttribute('width')).toBe('15')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByText('OpenCode Zen · Ling-3.0-tiny Free')).toBeTruthy()
    const allButton = screen.getByRole('button', {
      name: 'Show all OpenCode models in model picker',
    })
    const noneButton = screen.getByRole('button', {
      name: 'Hide all OpenCode models from model picker',
    })
    const ling = screen.getByRole('switch', {
      name: 'Include OpenCode Zen · Ling-3.0-tiny Free in model picker',
    })
    const qwen = screen.getByRole('switch', {
      name: 'Include OpenCode Go · Qwen3.8 Max in model picker',
    })
    expect(allButton.textContent).toBe('All')
    expect(noneButton.textContent).toBe('None')
    expect((allButton as HTMLButtonElement).disabled).toBe(false)
    expect((noneButton as HTMLButtonElement).disabled).toBe(false)
    expect(
      screen.queryByRole('switch', {
        name: 'Include models from OpenCode in model picker',
      }),
    ).toBeNull()
    expect(ling.getAttribute('aria-checked')).toBe('false')
    expect(qwen.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(allButton)
    expect(onModelVisibilityChange).toHaveBeenCalledOnce()
    expect(onModelVisibilityChange).toHaveBeenCalledWith('opencode:ling', true)

    onModelVisibilityChange.mockClear()
    view.rerender(settings(new Set()))
    const disabledAllButton = screen.getByRole('button', {
      name: 'Show all OpenCode models in model picker',
    })
    const enabledNoneButton = screen.getByRole('button', {
      name: 'Hide all OpenCode models from model picker',
    })
    expect((disabledAllButton as HTMLButtonElement).disabled).toBe(true)
    expect((enabledNoneButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(enabledNoneButton)
    expect(onModelVisibilityChange).toHaveBeenCalledTimes(2)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(1, 'opencode:ling', false)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(2, 'opencode:qwen', false)

    onModelVisibilityChange.mockClear()
    view.rerender(settings(new Set(['opencode:ling', 'opencode:qwen'])))
    const enabledAllButton = screen.getByRole('button', {
      name: 'Show all OpenCode models in model picker',
    })
    const disabledNoneButton = screen.getByRole('button', {
      name: 'Hide all OpenCode models from model picker',
    })
    expect((enabledAllButton as HTMLButtonElement).disabled).toBe(false)
    expect((disabledNoneButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(enabledAllButton)
    expect(onModelVisibilityChange).toHaveBeenCalledTimes(2)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(1, 'opencode:ling', true)
    expect(onModelVisibilityChange).toHaveBeenNthCalledWith(2, 'opencode:qwen', true)

    onModelVisibilityChange.mockClear()
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Include OpenCode Zen · Ling-3.0-tiny Free in model picker',
      }),
    )
    expect(onModelVisibilityChange).toHaveBeenCalledWith('opencode:ling', true)
    expect(screen.getByText('OpenCode Go · Qwen3.8 Max')).toBeTruthy()
  })

  it('omits stored custom-model management from beta settings', () => {
    const custom = customModelChoice(
      { provider: 'codex', modelId: 'qwen-max', displayName: 'Qwen Max' },
      'Codex',
      'openai',
    )
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
        acpAgents={[]}
        modelConnections={[]}
        models={[custom]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
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
        key: 'opencode:ling',
        provider: 'opencode',
        sourceName: 'OpenCode',
        mark: 'opencode',
        model: {
          id: 'zen/ling-3.0-tiny',
          displayName: 'OpenCode Zen · Ling-3.0-tiny Free',
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
        acpAgents={[]}
        modelConnections={[]}
        models={models}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
        showMacOSFontSmoothing={false}
        macOSFontSmoothing={true}
        onMacOSFontSmoothingChange={() => {}}
        onAccountChange={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    const group = screen.getByRole('region', { name: 'OpenCode' })
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
        // The Kimi CLI on this machine is already logged in; Qwen is not.
        if (request.agent) return { signedIn: request.agent === 'kimi' }
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
        acpAgents={[
          // A stale server may still list retired gemini; the row must not render.
          {
            id: 'gemini',
            name: 'Gemini CLI',
            installed: false,
            verified: true,
            setup: {
              installUrl: 'https://example.test/gemini',
              installCommand: 'npm install -g @google/gemini-cli',
              login: 'provider',
            },
          },
          {
            id: 'qwen',
            name: 'Qwen Code',
            installed: false,
            verified: false,
            setup: {
              installUrl: 'https://example.test/qwen',
              installCommand: 'npm install -g @qwen-code/qwen-code',
              login: 'provider',
            },
          },
          {
            id: 'kimi',
            name: 'Kimi CLI',
            installed: true,
            verified: true,
            setup: {
              installUrl: 'https://example.test/kimi',
              login: 'provider',
            },
          },
        ]}
        modelConnections={[]}
        models={[]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={() => {}}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
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
    const email = within(codexRow).getByText('private@example.com')
    expect(email.className).toBe('settings__email-value')
    const emailButton = email.closest<HTMLButtonElement>('.settings__email')
    expect(emailButton?.getAttribute('title')).toBe('Click to reveal email')
    expect(emailButton?.getAttribute('data-revealed')).toBe('false')
    if (!emailButton) throw new Error('redacted email button missing')
    fireEvent.click(emailButton)
    expect(emailButton.getAttribute('data-revealed')).toBe('true')
    expect(emailButton.getAttribute('title')).toBe('Click to hide email')
    expect(within(codexRow).queryByText(/\*+@example\.com/)).toBeNull()

    // Beta scope: agent rows and the API-connection form stay out entirely,
    // even when the server still reports agents.
    expect(screen.queryByText('Gemini CLI')).toBeNull()
    expect(screen.queryByText('Qwen Code')).toBeNull()
    expect(screen.queryByText('Kimi CLI')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect another plan or API' })).toBeNull()

    const claudeRow = screen.getByText('Claude Code').closest<HTMLElement>('.settings__row')
    const grokRow = screen.getByText('Grok').closest<HTMLElement>('.settings__row')
    expect(claudeRow?.querySelector('.provider-row__status')?.textContent).toBe(
      'Authenticated as claude@example.com · pro',
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
        provider="codex"
        providerName="Codex"
        transport={transport}
        projectPath={undefined}
        projectName={undefined}
        account={undefined}
        providerStatuses={[
          {
            id: 'opencode',
            displayName: 'OpenCode',
            installed: false,
            auth: 'unknown',
            setup: {
              installUrl: 'https://example.test/opencode',
              installCommand: 'npm install -g opencode-ai',
              login: 'provider',
            },
          },
        ]}
        acpAgents={[]}
        modelConnections={[]}
        models={[]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={onChanged}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
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
        params: { provider: 'opencode', columns: 100, rows: 30 },
      }),
    )

    transport.emit('terminal.output', {
      terminalId: 'term-install-2',
      data: 'added 12 packages\r\n',
    })
    const installRow = providerRow('OpenCode')
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
        acpAgents={[
          {
            id: 'kimi',
            name: 'Kimi CLI',
            installed: true,
            verified: true,
            setup: {
              installUrl: 'https://example.test/kimi',
              login: 'provider',
            },
            problem: 'Vendor ended individual sign-in.',
          },
        ]}
        modelConnections={[]}
        models={[]}
        hiddenModels={new Set()}
        onModelVisibilityChange={() => {}}
        onConnectionsChanged={onConnectionsChanged}
        projectCount={0}
        sidebarSettings={{ mode: 'classic', autoSettleDays: 3 }}
        onSidebarSettingsChange={() => {}}
        themePreference="system"
        onThemePreferenceChange={() => {}}
        fontPreference="geist"
        onFontPreferenceChange={() => {}}
        accentPreference="neutral"
        onAccentPreferenceChange={() => {}}
        backdropPreference="default"
        onBackdropPreferenceChange={() => {}}
        sidebarGlass={0}
        onSidebarGlassChange={() => {}}
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

    // Beta scope: agent rows never render, even when the server reports one.
    expect(screen.queryByText('Kimi CLI')).toBeNull()
    expect(open).toHaveBeenCalledTimes(1)
    expect(onConnectionsChanged).not.toHaveBeenCalled()
  })

  it('hands Claude login to the expanded workspace terminal', async () => {
    const transport = new TestTransport(async (method) => {
      if (method === 'auth.status') return { signedIn: false }
      if (method === 'providers.launch') return { terminalId: 'term-claude-login' }
      throw new Error(`unexpected ${method}`)
    })
    const onProviderLoginTerminalOpen = vi.fn()

    render(
      <ProviderSettings
        provider="codex"
        account={undefined}
        providerStatuses={[
          {
            id: 'claude-code',
            displayName: 'Claude Code',
            installed: true,
            auth: 'unknown',
            setup: {
              installUrl: 'https://code.claude.com/docs/en/getting-started',
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

    const signIn = await screen.findByRole('button', { name: 'Sign in' })
    fireEvent.click(signIn)

    await waitFor(() =>
      expect(onProviderLoginTerminalOpen).toHaveBeenCalledWith({
        provider: 'claude-code',
        displayName: 'Claude Code',
        installKey: 'login:claude-code',
      }),
    )
    expect(transport.requests).toContainEqual({
      method: 'providers.launch',
      params: { provider: 'claude-code', columns: 320, rows: 30 },
    })
    expect(screen.queryByTestId('install-terminal')).toBeNull()
  })
})
