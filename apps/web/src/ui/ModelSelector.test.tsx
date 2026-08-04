// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Model } from '@harness/contracts'
import { useState, type ReactNode } from 'react'
import type { ModelChoice } from '../model-catalog.js'

vi.mock('./Menu.js', () => ({
  Menu(props: {
    trigger: (open: boolean) => ReactNode
    children: (close: () => void) => ReactNode
    disabled?: boolean
    label?: string
    panelRole?: string
    panelLabel?: string
    panelClassName?: string
  }) {
    const [open, setOpen] = useState(false)
    return (
      <div>
        <button
          type="button"
          disabled={props.disabled}
          aria-label={props.label}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
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

beforeEach(() => {
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
})

describe('ModelSelector', () => {
  it('formats trigger labels and helper values for the combined pill', () => {
    renderSelector()
    const trigger = screen.getByRole('button', { name: 'Model and reasoning' })

    expect(trigger.textContent).toContain('5.6 Sol')
    expect(trigger.textContent).toContain('Extra High')
    expect(trigger.querySelector('.model-selector__trigger-fast')).toBeNull()
    expect(getCompactModelName('GPT-5.6 Sol')).toBe('5.6 Sol')
    expect(getFriendlyEffortLabel('xhigh')).toBe('Extra High')
  })

  it('shows active fast mode in the compact trigger', () => {
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

  it('opens a dialog panel, toggles fast mode, and falls back to undefined when default fast would keep it on', () => {
    const { onServiceTierChange } = renderSelector()

    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    expect(screen.getByRole('dialog', { name: 'Model and reasoning' })).toBeTruthy()
    expect(screen.getByText('1.5× Speed · 2.5× Usage')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Enable fast mode' }))
    expect(onServiceTierChange).toHaveBeenCalledWith('priority')

    cleanup()
    const fastDefaultModel = {
      ...MODELS[1]!,
      model: { ...MODELS[1]!.model, defaultServiceTier: 'fast' },
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

    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disable fast mode' }))
    expect(toggleFastOff).toHaveBeenCalledWith(undefined)
    expect(getFastModeOffValue(fastDefaultModel.model)).toBeUndefined()
  })

  it('uses pointer capture for the effort slider preview and commits on release', () => {
    const { onEffortChange } = renderSelector({ effort: 'medium' })

    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
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

    fireEvent.pointerDown(slider, { clientX: 110, pointerId: 4 })
    fireEvent.pointerMove(slider, { clientX: 350, pointerId: 4 })
    expect(slider.getAttribute('aria-valuetext')).toBe('Extra High')
    expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
      'Effort: Extra High',
    )
    expect(onEffortChange).not.toHaveBeenCalled()
    expect(slider.querySelectorAll('canvas')).toHaveLength(2)
    expect(slider.querySelectorAll('.model-selector__slider-stop')).toHaveLength(4)
    expect(slider.querySelector('.model-selector__slider-thumb')).toBeNull()

    fireEvent.pointerUp(slider, { clientX: 350, pointerId: 4 })
    expect(onEffortChange).toHaveBeenCalledWith('xhigh')
  })

  it('supports arrow and Home/End keyboard movement on the discrete slider', () => {
    const { onEffortChange } = renderSelector({ effort: 'medium' })

    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' })

    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyDown(slider, { key: 'Home' })

    expect(onEffortChange).toHaveBeenNthCalledWith(1, 'high')
    expect(onEffortChange).toHaveBeenNthCalledWith(2, 'xhigh')
    expect(onEffortChange).toHaveBeenNthCalledWith(3, 'low')
  })

  it('shows compact models immediately and keeps fast intent when switching models', () => {
    const { onModelChange, onEffortChange, onServiceTierChange } = renderSelector({
      effort: 'xhigh',
      serviceTier: 'priority',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    expect(screen.queryByText('Advanced')).toBeNull()
    expect(screen.queryByText('Best for broad tasks')).toBeNull()
    expect(screen.getByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Mini through Codex' }))

    expect(onModelChange).toHaveBeenCalledWith('codex:gpt-5.6-mini')
    expect(onEffortChange).toHaveBeenCalledWith('low')
    expect(onServiceTierChange).toHaveBeenCalledWith('fast')
    expect(screen.getByRole('dialog', { name: 'Model and reasoning' })).toBeTruthy()
  })

  it('renders one section per source instead of repeating it on every row', () => {
    const claudeModel: ModelChoice = {
      key: 'claude-code:auto',
      provider: 'claude-code',
      sourceName: 'Claude Code',
      mark: 'anthropic',
      model: {
        id: 'auto',
        displayName: 'Automatic',
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

    renderSelector({ models: [...MODELS, claudeModel] })
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))

    const titles = Array.from(document.querySelectorAll('.model-selector__group-title')).map(
      (title) => title.textContent,
    )
    expect(titles).toEqual(['Codex', 'Claude Code'])
    expect(document.querySelectorAll('.model-selector__model-source')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Use Automatic through Claude Code' })).toBeTruthy()
  })

  it('maps pointer positions onto discrete effort stops', () => {
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
    ).toBeCloseTo(0.405, 3)
  })
})
