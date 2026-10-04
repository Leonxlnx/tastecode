// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Model } from '@harness/contracts'
import { useState, type ReactNode } from 'react'
import type { ModelChoice } from '../model-catalog.js'

const haptics = vi.hoisted(() => ({
  performAppHaptic: vi.fn(),
  prepareAppHaptics: vi.fn(),
}))

const menuTriggerIntent = vi.hoisted(() => vi.fn())

vi.mock('../haptics.js', () => haptics)

vi.mock('./Menu.js', () => ({
  Menu(props: {
    trigger: (open: boolean) => ReactNode
    children: (close: () => void) => ReactNode
    disabled?: boolean
    label?: string
    panelRole?: string
    panelLabel?: string
    panelClassName?: string
    onOpen?: () => void
    onTriggerIntent?: () => void
  }) {
    const [open, setOpen] = useState(false)
    return (
      <div>
        <button
          type="button"
          disabled={props.disabled}
          aria-label={props.label}
          aria-expanded={open}
          onPointerEnter={() => {
            props.onTriggerIntent?.()
            if (props.onTriggerIntent) menuTriggerIntent()
          }}
          onFocus={() => {
            props.onTriggerIntent?.()
            if (props.onTriggerIntent) menuTriggerIntent()
          }}
          onClick={() =>
            setOpen((current) => {
              if (!current) props.onOpen?.()
              return !current
            })
          }
        >
          {props.trigger(open)}
        </button>
        {open ? (
          <div
            role={props.panelRole ?? 'menu'}
            aria-label={props.panelLabel}
            className={props.panelClassName}
          >
            {props.children(() => setOpen(false))}
          </div>
        ) : null}
      </div>
    )
  },
}))

import {
  ModelSelector,
  getCompactModelName,
  getEffortIndexFromPointer,
  getEffortProgressFromPointer,
  getFastModeOffValue,
  getFriendlyEffortLabel,
  groupModelsBySource,
} from './ModelSelector.js'

const RAW_MODELS: Model[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    description: 'Best for broad tasks',
    isDefault: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [
      { id: 'standard', name: 'Standard', description: 'Balanced speed' },
      { id: 'priority', name: 'Fast', description: '1.5x speed' },
    ],
    defaultServiceTier: 'standard',
  },
  {
    id: 'gpt-5.6-mini',
    displayName: 'GPT-5.6 Mini',
    description: 'Small and fast',
    isDefault: false,
    reasoningEfforts: ['low', 'medium'],
    defaultReasoningEffort: 'low',
    serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Fast lane' }],
    defaultServiceTier: 'fast',
  },
]
const MODELS: ModelChoice[] = RAW_MODELS.map((model) => ({
  key: `codex:${model.id}`,
  provider: 'codex',
  sourceName: 'Codex',
  mark: 'openai',
  model,
}))

type RenderOverrides = Partial<React.ComponentProps<typeof ModelSelector>>

function renderSelector(overrides: RenderOverrides = {}) {
  const onModelChange = vi.fn()
  const onEffortChange = vi.fn()
  const onServiceTierChange = vi.fn()

  render(
    <ModelSelector
      models={MODELS}
      modelId="codex:gpt-5.6-sol"
      effort="xhigh"
      serviceTier="standard"
      disabled={false}
      onModelChange={onModelChange}
      onEffortChange={onEffortChange}
      onServiceTierChange={onServiceTierChange}
      {...overrides}
    />,
  )

  return { onModelChange, onEffortChange, onServiceTierChange }
}

async function openSelector() {
  fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
  await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull())
}

beforeEach(() => {
  haptics.performAppHaptic.mockClear()
  haptics.prepareAppHaptics.mockClear()
  menuTriggerIntent.mockClear()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value(this: HTMLElement, pointerId: number) {
      ;(this as HTMLElement & { __pointerCapture?: number }).__pointerCapture = pointerId
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value(this: HTMLElement, pointerId: number) {
      const target = this as HTMLElement & { __pointerCapture?: number }
      if (target.__pointerCapture === pointerId) delete target.__pointerCapture
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', {
    configurable: true,
    value(this: HTMLElement, pointerId: number) {
      return (this as HTMLElement & { __pointerCapture?: number }).__pointerCapture === pointerId
    },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.removeItem('harness.modelPickerLayout')
})

describe('ModelSelector', () => {
  it('formats trigger labels and helper values for the combined pill', async () => {
    renderSelector()
    const trigger = screen.getByRole('button', { name: 'Model and reasoning' })

    expect(trigger.textContent).toContain('5.6 Sol')
    expect(trigger.textContent).toContain('Extra High')
    expect(trigger.querySelector('.model-selector__trigger-fast')).toBeNull()
    expect(getCompactModelName('GPT-5.6 Sol')).toBe('5.6 Sol')
    expect(getFriendlyEffortLabel('xhigh')).toBe('Extra High')
  })

  it('shows active fast mode in the compact trigger', async () => {
    renderSelector({ serviceTier: 'priority' })

    const trigger = screen.getByRole('button', { name: 'Model and reasoning' })
    expect(trigger.querySelector('.model-selector__trigger-fast')).not.toBeNull()
    expect(
      Array.from(trigger.querySelector('.model-selector__trigger')?.children ?? []).map(
        (element) => element.className,
      ),
    ).toEqual([
      'model-selector__trigger-fast',
      'model-selector__trigger-copy',
      'model-selector__trigger-chevron',
    ])
  })

  it('requests the full catalog only when the picker opens', async () => {
    const onOpen = vi.fn()
    renderSelector({ onOpen })

    expect(onOpen).not.toHaveBeenCalled()
    await openSelector()

    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('warms the lazy panel on pointer and focus without opening it', () => {
    renderSelector()

    const trigger = screen.getByRole('button', { name: 'Model and reasoning' })
    fireEvent.pointerEnter(trigger)
    fireEvent.focus(trigger)

    expect(menuTriggerIntent).toHaveBeenCalledTimes(2)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog', { name: 'Model and reasoning' })).toBeNull()
  })

  it('opens a dialog panel, toggles fast mode, and falls back to undefined when default fast would keep it on', async () => {
    const { onServiceTierChange } = renderSelector()

    await openSelector()
    expect(screen.getByRole('dialog', { name: 'Model and reasoning' })).toBeTruthy()
    // Tier descriptions are data, not UI: the panel shows no plan copy.
    expect(screen.queryByText('1.5x speed')).toBeNull()
    expect(screen.queryByText('1.5× Speed · 2.5× Usage')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Enable fast mode' }))
    expect(onServiceTierChange).toHaveBeenCalledWith('priority')

    cleanup()
    const fastDefaultModel = {
      ...MODELS[1]!,
      model: {
        ...MODELS[1]!.model,
        defaultServiceTier: 'fast',
        serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }],
      },
    }
    const toggleFastOff = vi.fn()

    render(
      <ModelSelector
        models={[fastDefaultModel]}
        modelId={fastDefaultModel.key}
        effort="low"
        serviceTier="fast"
        disabled={false}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onServiceTierChange={toggleFastOff}
      />,
    )

    await openSelector()
    expect(document.querySelector('.model-selector__fast-meta')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Disable fast mode' }))
    expect(toggleFastOff).toHaveBeenCalledWith(undefined)
    expect(getFastModeOffValue(fastDefaultModel.model)).toBeUndefined()
  })

  it('uses pointer capture for the effort slider preview and commits on release', async () => {
    const { onEffortChange } = renderSelector({ effort: 'medium' })

    await openSelector()
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' })
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 100,
      top: 20,
      width: 280,
      height: 44,
      right: 380,
      bottom: 64,
      toJSON: () => ({}),
    })

    fireEvent.pointerEnter(slider)
    fireEvent.pointerDown(slider, { clientX: 110, pointerId: 4 })
    fireEvent.pointerMove(slider, { clientX: 350, pointerId: 4 })
    fireEvent.pointerMove(slider, { clientX: 350, pointerId: 4 })
    expect(slider.getAttribute('aria-valuetext')).toBe('Extra High')
    expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
      'Effort: Extra High',
    )
    expect(onEffortChange).not.toHaveBeenCalled()
    expect(slider.querySelectorAll('canvas')).toHaveLength(2)
    expect(slider.querySelectorAll('.model-selector__slider-stop')).toHaveLength(4)
    expect(slider.querySelector('.model-selector__slider-thumb')).toBeNull()
    expect(haptics.prepareAppHaptics).toHaveBeenCalled()
    expect(haptics.performAppHaptic).toHaveBeenCalledTimes(2)
    expect(haptics.performAppHaptic).toHaveBeenNthCalledWith(1, 'alignment')
    expect(haptics.performAppHaptic).toHaveBeenNthCalledWith(2, 'alignment')

    fireEvent.pointerUp(slider, { clientX: 350, pointerId: 4 })
    expect(onEffortChange).toHaveBeenCalledWith('xhigh')
  })

  it('supports arrow and Home/End keyboard movement on the discrete slider', async () => {
    const { onEffortChange } = renderSelector({ effort: 'medium' })

    await openSelector()
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' })

    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyDown(slider, { key: 'Home' })

    expect(onEffortChange).toHaveBeenNthCalledWith(1, 'high')
    expect(onEffortChange).toHaveBeenNthCalledWith(2, 'xhigh')
    expect(onEffortChange).toHaveBeenNthCalledWith(3, 'low')
  })

  it('shows compact models immediately and leaves effort and tier to the owner', async () => {
    const { onModelChange, onEffortChange, onServiceTierChange } = renderSelector({
      effort: 'xhigh',
      serviceTier: 'priority',
    })

    await openSelector()
    expect(screen.queryByText('Advanced')).toBeNull()
    expect(screen.queryByText('Best for broad tasks')).toBeNull()
    expect(screen.getByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Mini through Codex' }))

    expect(onModelChange).toHaveBeenCalledWith('codex:gpt-5.6-mini')
    // Effort and tier for the new model are the owner's decision — it may be
    // restoring the setup last used with that provider. A second answer from
    // here raced that restore and overwrote it.
    expect(onEffortChange).not.toHaveBeenCalled()
    expect(onServiceTierChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Model and reasoning' })).toBeTruthy()
  })

  it('defaults to the flat list with inline provider headings', async () => {
    renderSelector()
    await openSelector()

    expect(screen.queryByRole('group', { name: 'Providers' })).toBeNull()
    expect(document.querySelector('.model-selector__models--flat')).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: 'Search models' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeTruthy()
    const heading = document.querySelector('.model-selector__group-title .source-identity')
    expect(heading?.getAttribute('title')).toBe('Codex')
    expect(heading?.querySelector('svg')?.getAttribute('width')).toBe('11')
  })

  it('searches every flat-list source without changing the selected model', async () => {
    const claude = {
      ...MODELS[0]!,
      key: 'claude-code:sonnet',
      provider: 'claude-code' as const,
      sourceName: 'Claude Code',
      mark: 'anthropic' as const,
      model: { ...MODELS[0]!.model, id: 'sonnet', displayName: 'Sonnet 5' },
    }
    const { onModelChange } = renderSelector({ models: [...MODELS, claude] })
    await openSelector()
    const search = screen.getByRole('searchbox', { name: 'Search models' })

    fireEvent.change(search, { target: { value: 'claude sonnet' } })
    expect(screen.getByRole('button', { name: 'Use Sonnet 5 through Claude Code' })).toBeTruthy()
    expect(onModelChange).not.toHaveBeenCalled()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeTruthy()
  })

  it('moves from model search into the matching results with arrow keys', async () => {
    renderSelector()
    await openSelector()
    const search = screen.getByRole('searchbox', { name: 'Search models' })

    fireEvent.change(search, { target: { value: 'mini' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Use GPT-5.6 Mini through Codex' }),
    )

    search.focus()
    fireEvent.change(search, { target: { value: '' } })
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Use GPT-5.6 Mini through Codex' }),
    )
  })

  it('omits controls when the selected model declares none', async () => {
    const plain = {
      ...MODELS[0]!,
      key: 'grok:plain',
      provider: 'grok' as const,
      sourceName: 'Grok',
      mark: 'grok' as const,
      model: { ...MODELS[0]!.model, reasoningEfforts: [], serviceTiers: [] },
    }
    renderSelector({ models: [plain], modelId: plain.key, effort: undefined })
    await openSelector()

    expect(document.querySelector('.model-selector__controls')).toBeNull()
    expect(screen.queryByRole('slider', { name: 'Reasoning effort' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Enable fast mode' })).toBeNull()
  })

  it('renders only a compact Fast control when effort is unsupported', async () => {
    const fastOnly = {
      ...MODELS[1]!,
      model: { ...MODELS[1]!.model, reasoningEfforts: [] },
    }
    renderSelector({
      models: [fastOnly],
      modelId: fastOnly.key,
      effort: undefined,
      serviceTier: 'fast',
    })
    await openSelector()

    expect(document.querySelector('.model-selector__controls.is-fast-only')).toBeTruthy()
    expect(screen.queryByRole('slider', { name: 'Reasoning effort' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Disable fast mode' })).toBeTruthy()
  })

  it('filters the model list through a provider logo rail', async () => {
    localStorage.setItem('harness.modelPickerLayout', 'rail')
    const claudeModel: ModelChoice = {
      key: 'claude-code:sonnet',
      provider: 'claude-code',
      sourceName: 'Claude Code',
      mark: 'anthropic',
      model: {
        id: 'sonnet',
        displayName: 'Sonnet 5',
        description: '',
        isDefault: false,
        reasoningEfforts: [],
        serviceTiers: [],
      },
    }

    expect(groupModelsBySource([...MODELS, claudeModel]).map((group) => group.name)).toEqual([
      'Codex',
      'Claude Code',
    ])

    const { onModelChange } = renderSelector({ models: [...MODELS, claudeModel] })
    await openSelector()

    expect(screen.getByRole('group', { name: 'Providers' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Show Codex models' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: 'Show Claude Code models' }).getAttribute('title'),
    ).toBe('Claude Code')
    expect(screen.queryByRole('button', { name: 'Use Sonnet 5 through Claude Code' })).toBeNull()

    const titles = Array.from(document.querySelectorAll('.model-selector__group-title')).map(
      (title) => title.textContent,
    )
    expect(titles).toEqual(['Codex'])
    expect(
      document
        .querySelector('.model-selector__group-title .source-identity')
        ?.getAttribute('title'),
    ).toBe('Codex')

    fireEvent.click(screen.getByRole('button', { name: 'Show Claude Code models' }))

    expect(
      screen.getByRole('button', { name: 'Show Claude Code models' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(screen.queryByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Use Sonnet 5 through Claude Code' })).toBeTruthy()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it('keeps ACP sources distinct by stable agent identity', async () => {
    const acpModels: ModelChoice[] = ['gemini', 'qwen'].map((agentId) => ({
      ...MODELS[0]!,
      key: `acp:${agentId}:default`,
      provider: 'acp',
      sourceName: 'Workspace agent',
      mark: 'acp',
      agent: { id: agentId, name: 'Workspace agent' },
      model: {
        ...MODELS[0]!.model,
        id: 'default',
        displayName: `${agentId} default`,
        reasoningEfforts: [],
        serviceTiers: [],
      },
    }))

    expect(groupModelsBySource(acpModels).map((group) => group.key)).toEqual([
      'acp:gemini',
      'acp:qwen',
    ])
  })

  it('searches every rail source without changing the selected model', async () => {
    localStorage.setItem('harness.modelPickerLayout', 'rail')
    const claudeModel: ModelChoice = {
      key: 'claude-code:sonnet',
      provider: 'claude-code',
      sourceName: 'Claude Code',
      mark: 'anthropic',
      model: {
        id: 'sonnet',
        displayName: 'Sonnet 5',
        description: '',
        isDefault: false,
        reasoningEfforts: [],
        serviceTiers: [],
      },
    }
    const { onModelChange } = renderSelector({ models: [...MODELS, claudeModel] })
    await openSelector()

    const search = screen.getByRole('searchbox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'mini' } })

    expect(screen.queryByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Use GPT-5.6 Mini through Codex' })).toBeTruthy()
    expect(onModelChange).not.toHaveBeenCalled()

    fireEvent.change(search, { target: { value: 'sonnet' } })
    expect(screen.getByRole('button', { name: 'Use Sonnet 5 through Claude Code' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Show Claude Code models' }).getAttribute('aria-pressed'),
    ).toBe('true')

    const claudeSearch = screen.getByRole('searchbox', { name: 'Search models' })
    fireEvent.keyDown(claudeSearch, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Use Sonnet 5 through Claude Code' }),
    )
    claudeSearch.focus()
    fireEvent.keyDown(claudeSearch, { key: 'Escape' })
    expect((claudeSearch as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('dialog', { name: 'Model and reasoning' })).toBeTruthy()
  })

  it('maps pointer positions onto discrete effort stops', async () => {
    expect(
      getEffortIndexFromPointer({
        clientX: 114,
        left: 100,
        width: 280,
        stopCount: 4,
      }),
    ).toBe(0)

    expect(
      getEffortIndexFromPointer({
        clientX: 352,
        left: 100,
        width: 280,
        stopCount: 4,
      }),
    ).toBe(3)

    expect(
      getEffortProgressFromPointer({
        clientX: 240,
        left: 100,
        width: 280,
      }),
    ).toBeCloseTo(0.5, 3)
  })

  it('switches only in the final quarter of a drag in either direction', () => {
    const at = (position: number, currentIndex: number) =>
      getEffortIndexFromPointer({
        clientX: 18 + position * 100,
        left: 0,
        width: 336,
        stopCount: 4,
        currentIndex,
      })
    expect(at(1.26, 2)).toBe(2)
    expect(at(1.25, 2)).toBe(1)
    expect(at(1.74, 1)).toBe(1)
    expect(at(1.75, 1)).toBe(2)
    expect(at(1.5, 2)).toBe(2)
    expect(at(1.5, 1)).toBe(1)
    expect(at(-1, 2)).toBe(0)
    expect(at(4, 1)).toBe(3)
  })
})
