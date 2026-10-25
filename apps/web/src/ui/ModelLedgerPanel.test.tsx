// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef } from 'react'
import type { Model, ProviderLimit } from '@harness/contracts'
import type { ModelChoice } from '../model-catalog.js'
import { MODEL_PICKER_LAYOUT_KEY, writeModelPickerLayout } from '../model-picker-layout.js'
import { MODEL_RECENTS_KEY } from '../model-recents.js'
import type { ProviderAccountsSnapshot } from '../provider-accounts-state.js'
import type { UsageSummaryState } from '../usage-summary-state.js'
import type { ModelLedgerData } from './model-ledger-context.js'
import { ModelSelector, type ModelPickerHandle } from './ModelSelector.js'

vi.mock('../haptics.js', () => ({ performAppHaptic: vi.fn(), prepareAppHaptics: vi.fn() }))

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function model(id: string, displayName: string, extra: Partial<Model> = {}): Model {
  return {
    id,
    displayName,
    isDefault: false,
    reasoningEfforts: EFFORTS,
    defaultReasoningEffort: 'high',
    serviceTiers: [],
    ...extra,
  }
}

const OPUS: ModelChoice = {
  key: 'claude-code:opus-5.5',
  provider: 'claude-code',
  sourceName: 'Claude Code',
  mark: 'anthropic',
  model: model('opus-5.5', 'Opus 5.5', {
    isDefault: true,
    description: 'Hard bugs and careful changes across many files.',
  }),
}
const SONNET: ModelChoice = {
  ...OPUS,
  key: 'claude-code:sonnet-5.5',
  model: model('sonnet-5.5', 'Sonnet 5.5', { defaultReasoningEffort: 'medium' }),
}
const ASTRA: ModelChoice = {
  key: 'codex:gpt-6-astra',
  provider: 'codex',
  sourceName: 'Codex',
  mark: 'openai',
  model: model('gpt-6-astra', 'GPT-6-Astra', {
    reasoningEfforts: [...EFFORTS, 'ultra'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
    description: 'Frontier intelligence for the most demanding work.',
  }),
}
const ASTRA_STUDIO: ModelChoice = {
  ...ASTRA,
  key: 'codex@studio:gpt-6-astra',
  sourceName: 'Codex (studio@example.invalid)',
  accountId: 'studio',
}
const GROK: ModelChoice = {
  key: 'grok:grok-build',
  provider: 'grok',
  sourceName: 'Grok',
  mark: 'grok',
  model: model('grok-build', 'Grok Build', {
    reasoningEfforts: [],
    defaultReasoningEffort: undefined,
  }),
}
const MODELS = [OPUS, SONNET, ASTRA, GROK]

const NOW = Date.now()
const window5h = (usedPercent: number): ProviderLimit => ({
  id: 'five_hour',
  label: 'Session',
  usedPercent,
  windowMinutes: 300,
  resetsAt: NOW + 3_600_000,
})
function ready(
  provider: UsageSummaryState['provider'],
  limits: ProviderLimit[],
  accountId?: string,
): UsageSummaryState {
  const tokens = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
  return {
    status: 'ready',
    provider,
    ...(accountId ? { accountId } : {}),
    summary: {
      session: tokens,
      today: tokens,
      limits,
      limitSource: { provider, status: 'ready', limits },
    },
  }
}
const ACCOUNTS: ProviderAccountsSnapshot = {
  phase: 'ready',
  accounts: [
    {
      id: 'default',
      provider: 'codex',
      label: 'Default',
      email: 'leon@example.invalid',
      plan: 'Pro',
      managed: false,
    },
    {
      id: 'studio',
      provider: 'codex',
      label: 'Studio',
      email: 'studio@example.invalid',
      home: 'E:\\accounts\\studio',
      managed: true,
    },
  ],
  active: {},
} as ProviderAccountsSnapshot

function renderLedger(
  overrides: Partial<React.ComponentProps<typeof ModelSelector>> = {},
  ledger: ModelLedgerData = {},
) {
  const onModelChange = vi.fn()
  const onEffortChange = vi.fn()
  const onServiceTierChange = vi.fn()
  const picker = createRef<ModelPickerHandle>()
  const view = render(
    <ModelSelector
      models={MODELS}
      modelId={OPUS.key}
      effort="high"
      serviceTier={undefined}
      disabled={false}
      onModelChange={onModelChange}
      onEffortChange={onEffortChange}
      onServiceTierChange={onServiceTierChange}
      ledger={ledger}
      pickerRef={picker}
      openShortcut={{ key: 'm', primary: true }}
      {...overrides}
    />,
  )
  return { onModelChange, onEffortChange, onServiceTierChange, picker, view }
}

async function openLedger() {
  fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
  return screen.findByRole('combobox', { name: 'Search models or providers' }, { timeout: 15_000 })
}

const highlighted = () =>
  document.querySelector<HTMLElement>('.model-ledger__row.is-highlighted')?.textContent
const inspector = () => document.querySelector<HTMLElement>('.model-ledger__inspector')!

// The picker's chunks load once here, so no test pays for the first import.
beforeAll(async () => {
  await import('./ModelSelectorPanel.js')
  await import('./ModelLedgerPanel.js')
}, 60_000)

beforeEach(() => {
  writeModelPickerLayout('ledger')
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  act(() => writeModelPickerLayout('list'))
  localStorage.removeItem(MODEL_PICKER_LAYOUT_KEY)
  localStorage.removeItem(MODEL_RECENTS_KEY)
})

describe('ledger trigger', () => {
  it('names the model and the effort in words, with a dial instead of dots', () => {
    renderLedger()
    const trigger = screen.getByRole('button', { name: 'Model and reasoning' })
    expect(trigger.textContent).toBe('Opus 5.5High')
    expect(trigger.querySelector('.model-ledger-dial')).toBeTruthy()
    expect(trigger.querySelector('.model-selector__trigger-dot')).toBeNull()
    expect(trigger.getAttribute('aria-keyshortcuts')).toBe('Meta+M Control+M')
  })

  it('says model, effort, engine, account and shortcut in its tooltip', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    renderLedger(
      { models: [ASTRA], modelId: ASTRA.key, effort: 'xhigh', serviceTier: 'priority' },
      { accounts: ACCOUNTS },
    )
    const tip = document.querySelector<HTMLElement>('.model-ledger-tip')!
    expect(tip.textContent).toContain('GPT-6 Astra · Extra high effort · Fast')
    expect(tip.textContent).toContain('Codex · leon@example.invalid')
    expect([...tip.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(['Ctrl', 'M'])
  })
})

describe('ledger panel', () => {
  it('opens on the model in use with its job, effort levels and default', async () => {
    renderLedger()
    const search = await openLedger()
    expect(document.activeElement).toBe(search)
    expect(highlighted()).toContain('Opus 5.5')
    expect(inspector().textContent).toContain('Hard bugs and careful changes across many files.')
    const levels = within(inspector()).getAllByRole('radio')
    expect(levels.map((level) => level.textContent)).toEqual([
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
    ])
    expect(
      within(inspector()).getByRole('radio', { name: 'High' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(inspector().textContent).toContain('Default for this model')
  })

  it('moves the model with Up and Down, previews effort with Left and Right, and uses both with Enter', async () => {
    const { onModelChange, onEffortChange } = renderLedger()
    const search = await openLedger()

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(highlighted()).toContain('Sonnet 5.5')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(highlighted()).toContain('GPT-6 Astra')
    // High on Opus is the middle of its scale; on Astra's longer scale it lands on High too.
    expect(
      within(inspector()).getByRole('radio', { name: 'High' }).getAttribute('aria-checked'),
    ).toBe('true')
    fireEvent.keyDown(search, { key: 'ArrowRight' })
    fireEvent.keyDown(search, { key: 'ArrowRight' })
    expect(
      within(inspector()).getByRole('radio', { name: 'Max' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(onEffortChange).not.toHaveBeenCalled()

    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onModelChange).toHaveBeenCalledWith(ASTRA.key)
    expect(onEffortChange).toHaveBeenCalledWith('max')
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
  })

  it('walks engines with Tab and Shift+Tab, wrapping around', async () => {
    renderLedger()
    const search = await openLedger()
    fireEvent.keyDown(search, { key: 'Tab' })
    expect(highlighted()).toContain('GPT-6 Astra')
    fireEvent.keyDown(search, { key: 'Tab' })
    expect(highlighted()).toContain('Grok Build')
    fireEvent.keyDown(search, { key: 'Tab' })
    expect(highlighted()).toContain('Opus 5.5')
    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true })
    expect(highlighted()).toContain('Grok Build')
    expect(inspector().textContent).toContain('Grok Build has no effort setting')
    expect(document.activeElement).toBe(search)
  })

  it('uses a model and an effort together from one click on a level', async () => {
    const { onModelChange, onEffortChange } = renderLedger()
    await openLedger()
    fireEvent.pointerMove(screen.getByRole('option', { name: /Sonnet 5.5/ }), {
      clientX: 40,
      clientY: 60,
    })
    expect(highlighted()).toContain('Sonnet 5.5')
    fireEvent.click(within(inspector()).getByRole('radio', { name: 'Low' }))
    expect(onModelChange).toHaveBeenCalledWith(SONNET.key)
    expect(onEffortChange).toHaveBeenCalledWith('low')
  })

  it('shows Fast only where the model declares the tier', async () => {
    const { onServiceTierChange, onModelChange } = renderLedger()
    const search = await openLedger()
    expect(within(inspector()).queryByRole('switch')).toBeNull()

    fireEvent.keyDown(search, { key: 'Tab' })
    const fast = within(inspector()).getByRole('switch', { name: /Fast/ })
    expect(fast.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(fast)
    expect(fast.getAttribute('aria-checked')).toBe('true')
    // Fast for another model waits for that model to be used.
    expect(onServiceTierChange).not.toHaveBeenCalled()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onModelChange).toHaveBeenCalledWith(ASTRA.key)
    expect(onServiceTierChange).toHaveBeenCalledWith('priority')
  })

  it('searches, clears with Escape and says when nothing matches', async () => {
    renderLedger()
    const search = await openLedger()
    fireEvent.change(search, { target: { value: 'son' } })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Sonnet 5.5',
    ])
    expect(highlighted()).toContain('Sonnet 5.5')
    fireEvent.change(search, { target: { value: 'gtp 7' } })
    expect(screen.getByRole('status').textContent).toContain('No model matches “gtp 7”')

    fireEvent.keyDown(search, { key: 'Escape' })
    expect((search as HTMLInputElement).value).toBe('')
    expect(highlighted()).toContain('Opus 5.5')
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  it('lists recent pairs that were sent, with their effort', async () => {
    localStorage.setItem(
      MODEL_RECENTS_KEY,
      JSON.stringify([
        { key: ASTRA.key, effort: 'xhigh', at: 2 },
        { key: OPUS.key, effort: 'high', at: 1 },
      ]),
    )
    const { onModelChange, onEffortChange } = renderLedger()
    await openLedger()
    const recent = screen.getByRole('option', { name: 'GPT-6 Astra, Extra high, Codex' })
    // The pair in use is not repeated as a recent.
    expect(screen.queryByRole('option', { name: 'Opus 5.5, High, Claude Code' })).toBeNull()
    fireEvent.click(recent)
    expect(onModelChange).toHaveBeenCalledWith(ASTRA.key)
    expect(onEffortChange).toHaveBeenCalledWith('xhigh')
  })

  it('names what it is still asking and offers Retry for a source that failed', async () => {
    const onRetrySources = vi.fn()
    renderLedger(
      {},
      {
        pendingSources: new Set(['antigravity']),
        sourceErrors: {
          opencode: {
            message: 'Could not load OpenCode models. opencode serve exited with code 1.',
          },
        },
        onRetrySources,
      },
    )
    await openLedger()
    const list = screen.getByRole('listbox', { name: 'Models' })
    expect(list.textContent).toContain('AntigravityAsking for models…')
    expect(list.textContent).toContain('opencode serve exited with code 1.')
    fireEvent.click(within(list).getByRole('button', { name: 'Retry' }))
    expect(onRetrySources).toHaveBeenCalledOnce()
  })

  it('shows each engine’s headroom and an amber share when it runs low', async () => {
    renderLedger(
      {},
      {
        limits: [
          ready('codex', [window5h(36)]),
          ready('grok', [window5h(94)]),
          ready('claude-code', []),
        ],
        accounts: ACCOUNTS,
      },
    )
    const search = await openLedger()
    const list = screen.getByRole('listbox', { name: 'Models' })
    expect(within(list).getByText('64% · 5h').className).toContain('is-quiet')
    expect(within(list).getByText('6% · 5h').className).toContain('is-low')
    expect(inspector().textContent).toContain('Limits not reported')

    fireEvent.keyDown(search, { key: 'Tab' })
    expect(inspector().textContent).toContain('leon@example.invalid')
    expect(inspector().textContent).toContain('64% of 5-hour left')
  })

  it('offers the other account when the plan limit is used up', async () => {
    const { onModelChange } = renderLedger(
      { models: [ASTRA, ASTRA_STUDIO], modelId: ASTRA.key, effort: 'xhigh' },
      {
        limits: [ready('codex', [window5h(100)]), ready('codex', [window5h(8)], 'studio')],
        accounts: ACCOUNTS,
      },
    )
    await openLedger()
    expect(screen.getByRole('listbox').textContent).toMatch(/Used up until/)
    expect(inspector().textContent).toContain('The 5-hour limit on leon@example.invalid is used up')
    fireEvent.click(
      within(inspector()).getByRole('button', { name: 'Use studio@example.invalid · 92% left' }),
    )
    expect(onModelChange).toHaveBeenCalledWith(ASTRA_STUDIO.key)
  })

  it('groups other engines under "Move this chat to" in a chat and says what moving does', async () => {
    renderLedger({}, { chat: { source: 'claude-code', provider: 'claude-code' } })
    const search = await openLedger()
    expect(screen.getByRole('listbox').textContent).toContain('Move this chat to')
    expect(inspector().textContent).not.toContain('switches this chat')
    fireEvent.keyDown(search, { key: 'Tab' })
    expect(inspector().textContent).toContain(
      'Your next message switches this chat to Codex. The conversation so far goes with it.',
    )
  })
})

describe('ledger shortcuts', () => {
  it('opens and closes through the picker handle, keeping focus where it was', async () => {
    const { picker } = renderLedger()
    const prompt = document.createElement('textarea')
    document.body.append(prompt)
    prompt.focus()

    act(() => picker.current?.toggle())
    const search = await screen.findByRole(
      'combobox',
      { name: 'Search models or providers' },
      { timeout: 15_000 },
    )
    await waitFor(() => expect(document.activeElement).toBe(search))
    act(() => picker.current?.toggle())
    await waitFor(() => expect(document.activeElement).toBe(prompt))
    prompt.remove()
  })

  it('steps effort up and round, and shows every level for a moment', () => {
    vi.useFakeTimers()
    try {
      const { picker, onEffortChange, view } = renderLedger({ effort: 'max' })
      act(() => picker.current?.stepEffort())
      expect(onEffortChange).toHaveBeenCalledWith('low')
      const hud = screen.getByRole('status')
      expect(hud.textContent).toBe('EffortLowMediumHighExtra highMax')
      view.rerender(
        <ModelSelector
          models={MODELS}
          modelId={OPUS.key}
          effort="low"
          serviceTier={undefined}
          disabled={false}
          onModelChange={vi.fn()}
          onEffortChange={onEffortChange}
          onServiceTierChange={vi.fn()}
          pickerRef={picker}
        />,
      )
      expect(screen.getByRole('status').querySelector('.is-on')?.textContent).toBe('Low')
      act(() => vi.advanceTimersByTime(1700))
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
