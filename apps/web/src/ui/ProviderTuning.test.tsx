// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Capabilities, Model, ProviderId, ProviderStatus } from '@harness/contracts'
import { choicesFor } from '../model-catalog.js'
import { TestTransport } from '../test-transport.js'
import {
  formatTokens,
  ProviderTuning,
  ProviderTuningSkeleton,
  useProviderContextSettings,
} from './ProviderTuning.js'

type TuningProps = Parameters<typeof ProviderTuning>[0]

const baseCapabilities: Capabilities = {
  steer: true,
  fork: true,
  interrupt: true,
  reasoningItems: true,
  approvals: true,
  images: true,
}

const claude: ProviderStatus = {
  id: 'claude-code',
  displayName: 'Claude Code',
  installed: true,
  auth: 'authenticated',
  capabilities: {
    ...baseCapabilities,
    autoReview: true,
    context: {
      windows: [200_000, 1_000_000],
      compaction: true,
      compactionOff: true,
      defaultCompactAt: 93,
      latestCompactAt: 93,
    },
  },
}

const codex: ProviderStatus = {
  id: 'codex',
  displayName: 'Codex',
  installed: true,
  auth: 'authenticated',
  capabilities: {
    ...baseCapabilities,
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

const grok: ProviderStatus = {
  id: 'grok',
  displayName: 'Grok',
  installed: true,
  auth: 'authenticated',
  capabilities: {
    ...baseCapabilities,
    context: { windows: [256_000], compaction: true, compactionOff: false, defaultCompactAt: 80 },
  },
}

function model(id: string, displayName: string, efforts: string[] = []): Model {
  return {
    id,
    displayName,
    isDefault: false,
    reasoningEfforts: efforts,
    ...(efforts.length > 0 ? { defaultReasoningEffort: 'medium' } : {}),
    serviceTiers: [],
  }
}

function modelsFor(provider: ProviderId, models: Model[]) {
  return choicesFor({ provider, sourceName: '', mark: 'anthropic' }, models)
}

const claudeModels = modelsFor('claude-code', [
  model('opus', 'Opus', ['low', 'medium', 'high']),
  model('sonnet', 'Sonnet', ['low', 'medium', 'high']),
  model('haiku', 'Haiku'),
])

function renderTuning(overrides: Partial<TuningProps> = {}) {
  const props: TuningProps = {
    provider: claude,
    models: claudeModels,
    pinned: undefined,
    onPinnedChange: vi.fn(),
    access: 'auto-review',
    onAccessChange: vi.fn(),
    context: { phase: 'ready', settings: {} },
    onContextChange: vi.fn(),
    ...overrides,
  }
  const view = render(<ProviderTuning {...props} />)
  return {
    props,
    rerender: (next: Partial<TuningProps>) => {
      Object.assign(props, next)
      view.rerender(<ProviderTuning {...props} />)
    },
  }
}

/** A closed row is one button named after its setting and the value it holds. */
function trigger(setting: string) {
  return screen.getByRole('button', { name: new RegExp(`^${setting}: `) })
}

function openPanel(setting: string, role: 'dialog' | 'menu' = 'dialog') {
  fireEvent.click(trigger(setting))
  return screen.getByRole(role, { name: setting })
}

function slider(name: string) {
  return screen.getByRole('slider', { name })
}

function press(element: HTMLElement, key: string) {
  fireEvent.keyDown(element, { key })
  fireEvent.keyUp(element, { key })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('formatTokens', () => {
  it('names windows the way providers advertise them', () => {
    expect(formatTokens(200_000)).toBe('200K')
    expect(formatTokens(272_000)).toBe('272K')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
  })
})

describe('provider defaults at a glance', () => {
  it('shows one value per setting and keeps every control closed', () => {
    renderTuning({ pinned: { model: 'opus', effort: 'high' } })
    const defaults = screen.getByRole('group', { name: 'Claude Code defaults' })
    expect(
      within(defaults)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Claude Code default model: Opus, High',
      'Claude Code default access: Auto-review',
      'Claude Code context: Compacts at 93%',
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('keeps the names and holds every value as a placeholder until the account is known', () => {
    const { rerender } = renderTuning({ pending: true })
    const defaults = screen.getByRole('group', { name: 'Claude Code defaults' })
    expect(defaults.getAttribute('aria-busy')).toBe('true')
    expect(within(defaults).queryByRole('button')).toBeNull()
    expect(
      Array.from(defaults.querySelectorAll('.provider-tune__label'), (label) => label.textContent),
    ).toEqual(['Model', 'Access', 'Context'])
    expect(defaults.querySelectorAll('.tune-skeleton')).toHaveLength(3)

    rerender({ pending: false })
    expect(defaults.hasAttribute('aria-busy')).toBe(false)
    expect(defaults.querySelector('.tune-skeleton')).toBeNull()
    expect(within(defaults).getAllByRole('button')).toHaveLength(3)
  })

  it('draws the frame of the defaults before any provider is known', () => {
    const { container } = render(<ProviderTuningSkeleton />)
    const frame = container.querySelector('.provider-tune')!
    expect(frame.getAttribute('aria-hidden')).toBe('true')
    expect(frame.textContent).toBe('ModelLoadingAccessLoadingContextLoading')
    expect(frame.querySelectorAll('.skeleton')).toHaveLength(3)
  })
})

describe('provider default model', () => {
  it('pins a model, carries an effort the next model offers, and returns to the last used', () => {
    const { props, rerender } = renderTuning()
    expect(trigger('Claude Code default model').textContent).toBe('Last used')

    let panel = openPanel('Claude Code default model')
    const lastUsed = within(panel).getByRole('button', { name: 'Last used' })
    expect(lastUsed.getAttribute('aria-pressed')).toBe('true')
    expect(document.getElementById(lastUsed.getAttribute('aria-describedby')!)?.textContent).toBe(
      'New chats keep the model you used last',
    )
    expect(within(panel).queryByRole('radiogroup')).toBeNull()

    fireEvent.click(within(panel).getByRole('button', { name: 'Opus' }))
    expect(props.onPinnedChange).toHaveBeenLastCalledWith({ model: 'opus' })

    // A model with effort levels keeps the panel open for them.
    rerender({ pinned: { model: 'opus', effort: 'high' } })
    panel = screen.getByRole('dialog', { name: 'Claude Code default model' })
    expect(within(panel).getByRole('radiogroup', { name: 'Claude Code default reasoning' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Sonnet' }))
    expect(props.onPinnedChange).toHaveBeenLastCalledWith({ model: 'sonnet', effort: 'high' })

    fireEvent.click(within(panel).getByRole('button', { name: 'Haiku' }))
    expect(props.onPinnedChange).toHaveBeenLastCalledWith({ model: 'haiku' })
    expect(screen.queryByRole('dialog')).toBeNull()

    panel = openPanel('Claude Code default model')
    fireEvent.click(within(panel).getByRole('button', { name: 'Last used' }))
    expect(props.onPinnedChange).toHaveBeenLastCalledWith(undefined)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names a pin the picker no longer offers instead of hiding it', () => {
    renderTuning({ pinned: { model: 'opus-old' }, pinnedName: 'Opus 4' })
    expect(trigger('Claude Code default model').textContent).toBe('Opus 4 (unavailable)')
    const panel = openPanel('Claude Code default model')
    const stale = within(panel).getByRole('button', { name: 'Opus 4 (unavailable)' })
    expect(stale.hasAttribute('disabled')).toBe(true)
    expect(stale.getAttribute('aria-pressed')).toBe('true')
    expect(within(panel).queryByRole('radiogroup')).toBeNull()
  })

  it('draws the effort beside the model and sets it on the ladder by click and by arrow keys', () => {
    const { props } = renderTuning({ pinned: { model: 'opus' } })
    const closed = trigger('Claude Code default model')
    expect(closed.getAttribute('aria-label')).toBe('Claude Code default model: Opus, Medium')
    expect(closed.querySelectorAll('.effort-glyph > [data-lit]')).toHaveLength(2)

    const panel = openPanel('Claude Code default model')
    const ladder = within(panel).getByRole('radiogroup', { name: 'Claude Code default reasoning' })
    const medium = within(ladder).getByRole('radio', { name: 'Medium' })
    expect(medium.getAttribute('aria-checked')).toBe('true')
    expect(ladder.parentElement?.textContent).toBe('EffortMedium · default')

    fireEvent.click(within(ladder).getByRole('radio', { name: 'High' }))
    expect(props.onPinnedChange).toHaveBeenLastCalledWith({ model: 'opus', effort: 'high' })

    fireEvent.keyDown(medium, { key: 'ArrowLeft' })
    expect(props.onPinnedChange).toHaveBeenLastCalledWith({ model: 'opus', effort: 'low' })
  })
})

describe('provider default access', () => {
  const modes = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole('menuitemradio')
      .map((item) => item.querySelector('.menu__label')?.textContent)

  it('offers auto-review only where the engine has a reviewer', () => {
    renderTuning({ provider: grok, models: [], access: 'full' })
    expect(modes(openPanel('Grok default access', 'menu'))).toEqual([
      'Ask first',
      'Auto-approve',
      'Full access',
    ])
  })

  it('shows the chosen mode with its icon and colour', () => {
    const { rerender } = renderTuning()
    const closed = trigger('Claude Code default access')
    expect(closed.textContent).toBe('Auto-review')
    expect(closed.querySelector('.tune-value')?.getAttribute('data-tone')).toBe('auto-review')
    expect(closed.querySelector('svg.tune-value__icon')).not.toBeNull()

    rerender({ access: 'full' })
    expect(closed.getAttribute('aria-label')).toBe('Claude Code default access: Full access')
    expect(closed.querySelector('.tune-value')?.getAttribute('data-tone')).toBe('full')
  })

  it('changes from the menu and closes it', () => {
    const { props } = renderTuning()
    const menu = openPanel('Claude Code default access', 'menu')
    expect(modes(menu)).toEqual(['Ask first', 'Auto-approve', 'Auto-review', 'Full access'])
    const selected = within(menu).getByRole('menuitemradio', { name: /^Auto-review/ })
    expect(selected.getAttribute('aria-checked')).toBe('true')
    expect(selected.textContent).toContain('Claude Code reviews elevated actions')

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /^Ask first/ }))
    expect(props.onAccessChange).toHaveBeenLastCalledWith('ask')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('provider context', () => {
  it('starts on the engine default and moves the compaction point with the keyboard', () => {
    const { props } = renderTuning()
    expect(trigger('Claude Code context').textContent).toBe('Compacts at 93%')
    const panel = openPanel('Claude Code context')
    const point = within(panel).getByRole('slider', { name: 'Claude Code compaction point' })
    expect(point.getAttribute('aria-valuenow')).toBe('93')
    expect(point.getAttribute('aria-valuetext')).toBe('Compacts at 93% of the window, the default')
    expect(within(panel).queryByRole('button', { name: /Reset Claude Code context/ })).toBeNull()

    press(point, 'ArrowLeft')
    expect(props.onContextChange).toHaveBeenLastCalledWith({ compactAt: 92 })
    press(point, 'Home')
    expect(props.onContextChange).toHaveBeenLastCalledWith({ compactAt: 10 })
    // The latest point Claude honours is its own default, which is no setting at all.
    press(point, 'End')
    expect(props.onContextChange).toHaveBeenCalledTimes(2)
  })

  it('updates the closed row while the point moves', () => {
    renderTuning()
    const closed = trigger('Claude Code context')
    const ring = closed.querySelector<SVGElement>('.ctx-glyph')!
    expect(ring.style.getPropertyValue('--at')).toBe('93')
    openPanel('Claude Code context')
    fireEvent.keyDown(slider('Claude Code compaction point'), { key: 'Home' })
    expect(ring.style.getPropertyValue('--at')).toBe('10')
    expect(closed.getAttribute('aria-label')).toBe('Claude Code context: Compacts at 10%')
  })

  it('stores the engine default as no setting, and resets a custom point', () => {
    const { props } = renderTuning({
      context: { phase: 'ready', settings: { 'claude-code': { compactAt: 92 } } },
    })
    expect(trigger('Claude Code context').textContent).toBe('Compacts at 92%')
    openPanel('Claude Code context')
    const point = slider('Claude Code compaction point')
    expect(point.getAttribute('aria-valuetext')).toBe('Compacts at 92% of the window')

    press(point, 'ArrowRight')
    expect(props.onContextChange).toHaveBeenLastCalledWith({})

    press(point, 'Delete')
    expect(props.onContextChange).toHaveBeenCalledTimes(2)
    expect(props.onContextChange).toHaveBeenLastCalledWith({})

    fireEvent.click(
      screen.getByRole('button', { name: 'Reset Claude Code context to its defaults' }),
    )
    expect(props.onContextChange).toHaveBeenLastCalledWith({})
  })

  it('keeps the compaction point when the window changes', () => {
    const { props } = renderTuning({
      context: { phase: 'ready', settings: { 'claude-code': { compactAt: 70 } } },
    })
    const panel = openPanel('Claude Code context')
    const windows = within(panel).getByRole('radiogroup', { name: 'Claude Code context window' })
    const sizes = within(windows).getAllByRole('radio')
    expect(sizes.map((size) => size.textContent)).toEqual(['Auto', '200K', '1M'])
    expect(sizes.map((size) => size.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ])
    fireEvent.click(within(windows).getByRole('radio', { name: '1M' }))
    expect(props.onContextChange).toHaveBeenLastCalledWith({ window: 1_000_000, compactAt: 70 })
    fireEvent.keyDown(sizes[0]!, { key: 'ArrowRight' })
    expect(props.onContextChange).toHaveBeenLastCalledWith({ window: 200_000, compactAt: 70 })
  })

  it('hands the window back to the model with Auto', () => {
    const { props } = renderTuning({
      context: {
        phase: 'ready',
        settings: { 'claude-code': { window: 1_000_000, compactAt: 70 } },
      },
    })
    expect(trigger('Claude Code context').textContent).toBe('1M · compacts at 70%')
    openPanel('Claude Code context')
    expect(screen.getByRole('radio', { name: '1M' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Auto' }))
    expect(props.onContextChange).toHaveBeenLastCalledWith({ compactAt: 70 })
  })

  it('switches automatic compaction off and back where the engine allows it', () => {
    const { props, rerender } = renderTuning()
    openPanel('Claude Code context')
    const auto = screen.getByRole('switch', { name: 'Compact Claude Code chats automatically' })
    expect(auto.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(auto)
    expect(props.onContextChange).toHaveBeenLastCalledWith({ compactAt: 'off' })

    rerender({ context: { phase: 'ready', settings: { 'claude-code': { compactAt: 'off' } } } })
    expect(auto.getAttribute('aria-checked')).toBe('false')
    expect(trigger('Claude Code context').textContent).toBe('Never compacts')
    const point = slider('Claude Code compaction point')
    expect(point.getAttribute('aria-valuetext')).toBe('Never compacts on its own')
    expect(point.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(auto)
    expect(props.onContextChange).toHaveBeenLastCalledWith({})
  })

  it('never offers a point later than the engine honours', () => {
    const { props } = renderTuning({ provider: codex, models: [], access: 'full' })
    openPanel('Codex context')
    expect(screen.queryByRole('switch')).toBeNull()
    const point = slider('Codex compaction point')
    expect(point.getAttribute('aria-valuemax')).toBe('90')
    press(point, 'ArrowRight')
    press(point, 'End')
    expect(props.onContextChange).not.toHaveBeenCalled()
  })

  it('shows a single window as a fact rather than a choice', () => {
    const { props } = renderTuning({ provider: grok, models: [], access: 'full' })
    expect(trigger('Grok context').textContent).toBe('Compacts at 80%')
    const panel = openPanel('Grok context')
    expect(within(panel).queryByRole('radiogroup')).toBeNull()
    expect(within(panel).getByText('256K')).toBeTruthy()
    press(slider('Grok compaction point'), 'End')
    expect(props.onContextChange).toHaveBeenLastCalledWith({ compactAt: 99 })
  })

  it('places the point where the pointer lets go and snaps to the default', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 200,
      top: 0,
      bottom: 32,
      width: 200,
      height: 32,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const { props } = renderTuning()
    openPanel('Claude Code context')
    const track = slider('Claude Code compaction point').parentElement!

    fireEvent.pointerDown(track, { button: 0, clientX: 100, pointerId: 1 })
    expect(slider('Claude Code compaction point').getAttribute('aria-valuenow')).toBe('50')
    fireEvent.pointerUp(track, { clientX: 100, pointerId: 1 })
    expect(props.onContextChange).toHaveBeenLastCalledWith({ compactAt: 50 })

    fireEvent.pointerDown(track, { button: 0, clientX: 186, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 186, pointerId: 1 })
    fireEvent.pointerDown(track, { button: 0, clientX: 198, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 198, pointerId: 1 })
    expect(props.onContextChange).toHaveBeenCalledTimes(1)
  })

  it('holds a placeholder while loading and says so when the settings cannot be read', () => {
    const { rerender } = renderTuning({ context: { phase: 'loading' } })
    const defaults = screen.getByRole('group', { name: 'Claude Code defaults' })
    expect(defaults.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByRole('button', { name: /^Claude Code context/ })).toBeNull()
    expect(defaults.querySelectorAll('.tune-skeleton')).toHaveLength(1)
    // Model and access are known locally and do not wait for the server.
    expect(trigger('Claude Code default model').textContent).toBe('Last used')

    rerender({ context: { phase: 'error', message: 'server is gone' } })
    expect(defaults.hasAttribute('aria-busy')).toBe(false)
    expect(screen.queryByRole('button', { name: /^Claude Code context/ })).toBeNull()
    expect(screen.getByText('Unavailable').getAttribute('title')).toBe('server is gone')
  })
})

function ConnectedTuning(props: { transport: TestTransport; enabled?: boolean }) {
  const context = useProviderContextSettings(props.transport, props.enabled ?? true)
  return (
    <ProviderTuning
      provider={claude}
      models={claudeModels}
      pinned={undefined}
      onPinnedChange={() => {}}
      access="ask"
      onAccessChange={() => {}}
      context={context.state}
      contextError={context.errors['claude-code']}
      onContextChange={(settings) => context.update('claude-code', settings)}
    />
  )
}

describe('useProviderContextSettings', () => {
  it('reads nothing until enabled', () => {
    const transport = new TestTransport()
    render(<ConnectedTuning transport={transport} enabled={false} />)
    expect(transport.requests).toEqual([])
  })

  it('shows an edit at once and keeps what the server saved', async () => {
    const transport = new TestTransport((method, params) => {
      if (method === 'providers.contextSettings') return {}
      if (method === 'providers.updateContextSettings') {
        const { provider, settings } = params as { provider: ProviderId; settings: object }
        return { [provider]: settings }
      }
      throw new Error(`unexpected ${method}`)
    })
    render(<ConnectedTuning transport={transport} />)
    await waitFor(() => expect(trigger('Claude Code context').hasAttribute('disabled')).toBe(false))
    openPanel('Claude Code context')
    const auto = screen.getByRole('switch', { name: 'Compact Claude Code chats automatically' })

    fireEvent.click(auto)
    expect(auto.getAttribute('aria-checked')).toBe('false')
    await waitFor(() =>
      expect(transport.requests).toContainEqual({
        method: 'providers.updateContextSettings',
        params: { provider: 'claude-code', settings: { compactAt: 'off' } },
      }),
    )
    expect(auto.getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('falls back to the saved state and says why when the server refuses', async () => {
    let reject!: (error: Error) => void
    const transport = new TestTransport((method) => {
      if (method === 'providers.contextSettings') return { 'claude-code': { compactAt: 60 } }
      if (method === 'providers.updateContextSettings') {
        return new Promise((_, rejectUpdate) => {
          reject = rejectUpdate
        })
      }
      throw new Error(`unexpected ${method}`)
    })
    render(<ConnectedTuning transport={transport} />)
    await waitFor(() => expect(trigger('Claude Code context').textContent).toBe('Compacts at 60%'))
    openPanel('Claude Code context')
    const point = slider('Claude Code compaction point')
    expect(point.getAttribute('aria-valuenow')).toBe('60')

    fireEvent.click(screen.getByRole('switch', { name: 'Compact Claude Code chats automatically' }))
    expect(point.getAttribute('aria-valuetext')).toBe('Never compacts on its own')
    await act(async () =>
      reject(new Error('This provider cannot switch automatic compaction off.')),
    )

    expect(point.getAttribute('aria-valuenow')).toBe('60')
    expect(screen.getByRole('alert').textContent).toBe(
      'Could not save the context setting. This provider cannot switch automatic compaction off.',
    )
  })
})
