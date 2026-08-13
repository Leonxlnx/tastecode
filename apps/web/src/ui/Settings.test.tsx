// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Account, ProviderId, ResultOf } from '@harness/contracts'
import { customModelChoice, type ModelChoice } from '../model-catalog.js'
import { MODEL_PICKER_LAYOUT_KEY, writeModelPickerLayout } from '../model-picker-layout.js'
import { resetInstalls } from '../provider-install.js'
import { HAPTICS_KEY, writeAppHaptics } from '../haptics.js'
import type { Transport } from '../transport.js'
import { ProviderSettings, Settings } from './Settings.js'

type ProviderStatus = ResultOf<'providers.list'>['providers'][number]

// The real component boots xterm, which needs a canvas happy-dom does not
// have. What these tests care about is *when* a terminal is offered, not how
// it paints.
vi.mock('./InstallTerminal.js', () => ({
  InstallTerminal: (props: { installKey: string }) => (
    <div data-testid="install-terminal" data-install-key={props.installKey} />
  ),
}))

function renderSettings(
  options: {
    initialSection?: 'appearance' | 'data' | 'about'
    onClose?: () => void
    onReset?: () => void
    transport?: Transport
    showMacOSHaptics?: boolean
  } = {},
) {
  const transport =
    options.transport ??
    ({
      request: vi.fn(),
      on: vi.fn(() => () => {}),
    } as unknown as Transport)

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

    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(screen.queryByRole('switch', { name: 'Provider rail layout' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Data & privacy' }))
    expect(screen.getByRole('heading', { name: 'Data & privacy' })).toBeTruthy()
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
    const request = vi.fn((method: string) => {
      if (method === 'system.updateCheck') return update.promise
      throw new Error(`unexpected ${method}`)
    })
    const { container } = renderSettings({
      initialSection: 'about',
      transport: { request, on: vi.fn(() => () => {}) } as unknown as Transport,
    })

    expect(screen.getByText('Browser · pre-release').className).toBe('settings-meta')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(screen.getByRole('status', { name: 'Checking' }).className).toContain('is-checking')

    await act(async () => update.resolve(result))

    expect((await screen.findByRole('status', { name: label })).className).toContain(`is-${state}`)
    expect(request).toHaveBeenCalledWith('system.updateCheck', {})
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
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderProviders(
  statuses: ProviderStatus[],
  request: (method: string, params: { provider?: ProviderId }) => unknown,
  account?: Account,
) {
  let listener: ((event: unknown) => void) | undefined
  const transport = {
    request: (method: string, params: { provider?: ProviderId }) => request(method, params),
    on: (_channel: string, next: (event: unknown) => void) => {
      listener = next
      return () => {}
    },
  } as unknown as Transport
  render(
    <ProviderSettings
      provider="codex"
      account={account}
      providerStatuses={statuses}
      acpAgents={[]}
      modelConnections={[]}
      transport={transport}
      onConnectionsChanged={() => {}}
      onAccountChange={() => {}}
    />,
  )
  return (loginId: string, success: boolean, error: string | null = null) =>
    act(() => listener?.({ provider: 'codex', loginId, success, error }))
}
function installedProvider(id: ProviderId, displayName: string): ProviderStatus {
  return { id, displayName, installed: true, auth: 'unknown' }
}
const providerRow = (name: string) =>
  screen.getByText(name).closest<HTMLElement>('.settings__row') as HTMLElement
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
        return { signedIn: params.provider === 'codex' }
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
        if (method === 'auth.status')
          return params.provider === 'codex' ? codexStatus.promise : { signedIn: true }
        return params.provider === 'codex' ? codexSignOut.promise : claudeSignOut.promise
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
  it('keeps every model visible while toggling picker inclusion individually', () => {
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
    const transport = {
      request: vi.fn(),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

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
        hiddenModels={new Set(['opencode:ling'])}
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
      />,
    )

    const categories = screen.getByRole('navigation', { name: 'Settings categories' })
    expect(within(categories).getAllByRole('button')[0]?.textContent).toBe('General')

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    const sourceHeading = screen.getByText('OpenCode').closest('.source-identity')
    expect(sourceHeading?.getAttribute('title')).toBe('OpenCode')
    expect(sourceHeading?.querySelector('svg')?.getAttribute('width')).toBe('15')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByText('OpenCode Zen · Ling-3.0-tiny Free')).toBeTruthy()
    const ling = screen.getByRole('switch', {
      name: 'Include OpenCode Zen · Ling-3.0-tiny Free in model picker',
    })
    const qwen = screen.getByRole('switch', {
      name: 'Include OpenCode Go · Qwen3.8 Max in model picker',
    })
    expect(ling.getAttribute('aria-checked')).toBe('false')
    expect(qwen.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(ling)
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
    const transport = {
      request: vi.fn(),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

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
    const transport = {
      request: vi.fn(),
      on: vi.fn(() => () => {}),
    } as unknown as Transport

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
  it('keeps custom harness controls separate from provider settings', () => {
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
    const accounts: Record<string, Account> = {
      codex: { signedIn: true, email: 'private@example.com', plan: 'pro' },
      'claude-code': { signedIn: true, plan: 'pro' },
      grok: { signedIn: false },
    }
    const transport = {
      request: vi.fn(async (method: string, params: { provider?: ProviderId; agent?: string }) => {
        if (method === 'auth.status') {
          // The Kimi CLI on this machine is already logged in; Qwen is not.
          if (params.agent) return { signedIn: params.agent === 'kimi' }
          return accounts[params.provider ?? '']
        }
        if (method === 'auth.startLogin') {
          return { loginId: 'login-1', authUrl: 'https://auth.example.test/' }
        }
        if (method === 'auth.signOut') return {}
        if (method === 'providers.install') return { terminalId: 'term-install-1' }
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn(() => () => {}),
    } as unknown as Transport
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

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(3))
    expect(screen.getAllByText('Codex')).toHaveLength(1)

    const codexRow = screen.getByText('Codex').closest<HTMLElement>('.settings__row')
    if (!codexRow) throw new Error('Codex provider row missing')
    const email = within(codexRow).getByText('private@example.com')
    expect(email.className).toBe('settings__email-value')
    expect(email.closest('.settings__email')?.getAttribute('title')).toBe('private@example.com')
    expect(within(codexRow).queryByText(/\*+@example\.com/)).toBeNull()

    // Retired agents stay hidden while supported ACP agents and API
    // connections return on nightly.
    expect(screen.queryByText('Gemini CLI')).toBeNull()
    expect(screen.getByText('Qwen Code')).toBeTruthy()
    expect(screen.getByText('Kimi CLI')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect another plan or API' })).toBeTruthy()

    const claudeRow = screen.getByText('Claude Code').closest<HTMLElement>('.settings__row')
    const grokRow = screen.getByText('Grok').closest<HTMLElement>('.settings__row')
    expect(claudeRow?.querySelector('.provider-row__status')?.textContent).toBe('Signed in · pro')
    if (!claudeRow || !grokRow) throw new Error('provider row missing')
    fireEvent.click(within(claudeRow).getByRole('button', { name: 'Sign out' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('auth.signOut', {
        provider: 'claude-code',
      }),
    )

    // Grok signs in through its own CLI: the row offers the guided card flow.
    expect(within(grokRow).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
  })

  it('runs installs in the background and refreshes once the install exits cleanly', async () => {
    const channels = new Map<string, Set<(data: unknown) => void>>()
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === 'providers.install') return { terminalId: 'term-install-2' }
        if (method === 'auth.status') return { signedIn: false }
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn((channel: string, listener: (data: unknown) => void) => {
        const listeners = channels.get(channel) ?? new Set()
        listeners.add(listener)
        channels.set(channel, listeners)
        return () => listeners.delete(listener)
      }),
    } as unknown as Transport
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
      expect(transport.request).toHaveBeenCalledWith('providers.install', {
        provider: 'opencode',
        columns: 100,
        rows: 30,
      }),
    )

    const emit = (channel: string, data: unknown) => {
      for (const listener of channels.get(channel) ?? []) listener(data)
    }
    emit('terminal.output', { terminalId: 'term-install-2', data: 'added 12 packages\r\n' })
    const installRow = providerRow('OpenCode')
    expect(within(installRow).getByRole('status').textContent).toContain('Installing…')
    expect(screen.queryByText('added 12 packages')).toBeNull()
    const details = within(installRow).getByRole('button', { name: 'Details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(await screen.findByTestId('install-terminal')).toBeTruthy()
    details.focus()

    emit('terminal.exit', { terminalId: 'term-install-2', exitCode: 0 })
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
    const channels = new Map<string, Set<(data: unknown) => void>>()
    let signedIn = false
    const transport = {
      request: vi.fn(async (method: string) => {
        if (method === 'providers.launch') return { terminalId: 'term-login-3' }
        if (method === 'auth.status') return { signedIn }
        throw new Error(`unexpected ${method}`)
      }),
      on: vi.fn((channel: string, listener: (data: unknown) => void) => {
        const listeners = channels.get(channel) ?? new Set()
        listeners.add(listener)
        channels.set(channel, listeners)
        return () => listeners.delete(listener)
      }),
    } as unknown as Transport
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

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(2))
    const grokRow = screen.getByText('Grok').closest<HTMLElement>('.settings__row')
    if (!grokRow) throw new Error('Grok row missing')
    fireEvent.click(within(grokRow).getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(transport.request).toHaveBeenCalledWith('providers.launch', {
        provider: 'grok',
        columns: 320,
        rows: 30,
      }),
    )
    expect(open).not.toHaveBeenCalled()
    // The guided card leads; the raw terminal waits behind Details.
    await waitFor(() => expect(screen.getByText('Starting the provider sign-in…')).toBeTruthy())
    expect(screen.queryByTestId('install-terminal')).toBeNull()

    const emit = (channel: string, data: unknown) => {
      for (const listener of channels.get(channel) ?? []) listener(data)
    }
    emit('terminal.output', {
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

    emit('terminal.output', {
      terminalId: 'term-login-3',
      data: '\u001b[32m✓ Signed in as grok.user@example.com\u001b[0m\r\n',
    })
    await waitFor(() =>
      expect(localStorage.getItem('harness.providerEmail.grok')).toBe('grok.user@example.com'),
    )
    signedIn = true
    emit('terminal.exit', { terminalId: 'term-login-3', exitCode: 0 })
    await waitFor(() => expect(screen.queryByTestId('install-terminal')).toBeNull())
    await waitFor(() => expect(providerRow('Grok').textContent).toContain('grok.user@example.com'))

    const kimiRow = screen.getByText('Kimi CLI').closest<HTMLElement>('.settings__row')
    if (!kimiRow) throw new Error('Kimi row missing')
    expect(within(kimiRow).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(open).toHaveBeenCalledTimes(1)
    expect(onConnectionsChanged).not.toHaveBeenCalled()
  })
})
