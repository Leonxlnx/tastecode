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
  localStorage.removeItem('harness.modelPickerLayout')
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

    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    expect(document.querySelector('.model-selector__fast-meta')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Disable fast mode' }))
    expect(toggleFastOff).toHaveBeenCalledWith(undefined)
    expect(getFastModeOffValue(fastDefaultModel.model)).toBeUndefined()
  })

  it('renders effort as plain buttons and commits the clicked value', () => {
    const { onEffortChange } = renderSelector({ effort: 'medium' })

    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    const group = screen.getByRole('radiogroup', { name: 'Reasoning effort' })
    const options = Array.from(group.querySelectorAll('button')).map((b) => b.textContent)
    expect(options).toEqual(['Low', 'Medium', 'High', 'Extra High'])
    expect(screen.getByRole('radio', { name: 'Medium' }).getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('.model-selector__effort-title')?.textContent).toBe(
      'Effort: Medium',
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Extra High' }))
    expect(onEffortChange).toHaveBeenCalledWith('xhigh')

    // Re-clicking the current value is a no-op, not a redundant commit.
    fireEvent.click(screen.getByRole('radio', { name: 'Medium' }))
    expect(onEffortChange).toHaveBeenCalledTimes(1)
  })

  it('shows compact models immediately and leaves effort and tier to the owner', () => {
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
    // Effort and tier for the new model are the owner's decision — it may be
    // restoring the setup last used with that provider. A second answer from
    // here raced that restore and overwrote it.
    expect(onEffortChange).not.toHaveBeenCalled()
    expect(onServiceTierChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Model and reasoning' })).toBeTruthy()
  })

  it('defaults to the flat list with inline provider headings', () => {
    renderSelector()
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))

    expect(screen.queryByRole('group', { name: 'Providers' })).toBeNull()
    expect(document.querySelector('.model-selector__models--flat')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeTruthy()
  })

  it('filters the model list through a provider logo rail', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Show Claude Code models' }))

    expect(
      screen.getByRole('button', { name: 'Show Claude Code models' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(screen.queryByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Use Sonnet 5 through Claude Code' })).toBeTruthy()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it('searches the active provider without changing the selected model', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))

    const search = screen.getByRole('searchbox', { name: 'Search Codex models' })
    fireEvent.change(search, { target: { value: 'mini' } })

    expect(screen.queryByRole('button', { name: 'Use GPT-5.6 Sol through Codex' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Use GPT-5.6 Mini through Codex' })).toBeTruthy()
    expect(onModelChange).not.toHaveBeenCalled()

    fireEvent.change(search, { target: { value: 'sonnet' } })
    expect(screen.getByRole('status').textContent).toBe('No matching models.')
    fireEvent.click(screen.getByRole('button', { name: 'Show Claude Code models' }))
    expect(screen.getByRole('button', { name: 'Use Sonnet 5 through Claude Code' })).toBeTruthy()

    const claudeSearch = screen.getByRole('searchbox', { name: 'Search Claude Code models' })
    fireEvent.keyDown(claudeSearch, { key: 'Escape' })
    expect((claudeSearch as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('dialog', { name: 'Model and reasoning' })).toBeTruthy()
  })

})
