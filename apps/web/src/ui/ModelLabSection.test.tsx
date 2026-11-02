// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ModelChoice } from '../model-catalog.js'
import { ModelLabSection } from './ModelLabSection.js'

afterEach(cleanup)

const LABS = [
  'DeepSeek',
  'Anthropic',
  'OpenAI',
  'Google',
  'xAI',
  'Moonshot',
  'Z.ai',
  'MiniMax',
  'Qwen',
  'Xiaomi',
] as const

/** Rows with a name of their own, by index; the rest are "Model <index>". */
const NAMES = new Map([
  [2, 'GPT-6.1 Sol'],
  [3, 'Gemini 4 Argon'],
  [12, 'GPT-6 Luna'],
])

function choice(index: number, lab: string | undefined): ModelChoice {
  return {
    key: `opencode:m-${index}`,
    provider: 'opencode',
    sourceName: 'OpenCode',
    mark: 'opencode',
    model: {
      id: `m-${index}`,
      displayName: NAMES.get(index) ?? `Model ${index}`,
      description: '',
      isDefault: false,
      reasoningEfforts: [],
      serviceTiers: [],
      ...(lab ? { lab } : {}),
    },
  }
}

/** 500 rows like a connected OpenCode with many providers: ten labs in turn, then ten without a lab. */
const choices = Array.from({ length: 500 }, (_, index) =>
  choice(index, index < 490 ? LABS[index % LABS.length] : undefined),
)
const keyOf = (index: number) => `opencode:m-${index}`
// DeepSeek's and Qwen's first models are in the picker; nothing else is.
const hiddenExcept = (...shown: number[]) =>
  new Set(choices.map((entry) => entry.key).filter((key) => !shown.map(keyOf).includes(key)))

function renderSection(options: { choices?: ModelChoice[]; hidden?: Set<string> } = {}) {
  const onModelVisibilityChange = vi.fn()
  const onModelsVisibilityChange = vi.fn()
  const element = (hidden: Set<string>) => (
    <ModelLabSection
      title="OpenCode"
      source="OpenCode"
      choices={options.choices ?? choices}
      hiddenModels={hidden}
      onModelVisibilityChange={onModelVisibilityChange}
      onModelsVisibilityChange={onModelsVisibilityChange}
    />
  )
  const view = render(element(options.hidden ?? hiddenExcept(0, 8)))
  return {
    ...view,
    onModelVisibilityChange,
    onModelsVisibilityChange,
    rerenderHidden: (hidden: Set<string>) => view.rerender(element(hidden)),
  }
}

const labNames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.model-lab__toggle'), (toggle) => toggle.textContent)
const labToggle = (name: string) =>
  screen.getByRole('button', { name, expanded: false }) as HTMLButtonElement
const search = (value: string) =>
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search OpenCode models' }), {
    target: { value },
  })

describe('ModelLabSection', () => {
  it('renders only the lab rows while every lab is collapsed', () => {
    const { container } = renderSection()

    expect(screen.queryAllByRole('switch')).toEqual([])
    expect(container.querySelectorAll('.set-row')).toHaveLength(LABS.length + 1)
    expect(screen.getByText('2 of 500 shown in the model picker.')).toBeTruthy()
    // Labs with a model in the picker first, then the source's order; the
    // rows without a lab close the list.
    expect(labNames(container)).toEqual([
      'DeepSeek',
      'Qwen',
      'Anthropic',
      'OpenAI',
      'Google',
      'xAI',
      'Moonshot',
      'Z.ai',
      'MiniMax',
      'Xiaomi',
      'Other',
    ])
    const deepSeek = labToggle('DeepSeek').closest('.set-row')!
    expect(deepSeek.querySelector('.model-lab__count')?.textContent).toBe('1 of 49')
    expect(deepSeek.hasAttribute('data-tone')).toBe(false)
    expect(labToggle('Xiaomi').closest('.set-row')?.getAttribute('data-tone')).toBe('muted')
    // Only the source's All and None until a lab opens.
    expect(container.querySelectorAll('.model-visibility__bulk-actions')).toHaveLength(1)
  })

  it('opens a lab and changes all of its models in one call', () => {
    const { container, onModelsVisibilityChange, rerenderHidden } = renderSection()

    const qwen = labToggle('Qwen')
    expect(qwen.hasAttribute('aria-controls')).toBe(false)
    fireEvent.click(qwen)
    expect(qwen.getAttribute('aria-expanded')).toBe('true')
    const rows = screen.getByRole('group', { name: 'Qwen models' })
    expect(qwen.getAttribute('aria-controls')).toBe(rows.id)
    expect(within(rows).getAllByRole('switch')).toHaveLength(49)
    expect(screen.getAllByRole('switch')).toHaveLength(49)

    fireEvent.click(
      screen.getByRole('button', { name: 'Hide all Qwen models from OpenCode from model picker' }),
    )
    expect(onModelsVisibilityChange).toHaveBeenCalledOnce()
    expect(onModelsVisibilityChange).toHaveBeenCalledWith([keyOf(8)], false)

    onModelsVisibilityChange.mockClear()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show all Qwen models from OpenCode in model picker' }),
    )
    expect(onModelsVisibilityChange).toHaveBeenCalledOnce()
    const qwenKeys = choices.filter((entry) => entry.model.lab === 'Qwen').map((entry) => entry.key)
    expect(onModelsVisibilityChange).toHaveBeenCalledWith(
      qwenKeys.filter((key) => key !== keyOf(8)),
      true,
    )

    // The source's own pair still covers every model.
    onModelsVisibilityChange.mockClear()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show all OpenCode models in model picker' }),
    )
    expect(onModelsVisibilityChange).toHaveBeenCalledOnce()
    expect(onModelsVisibilityChange.mock.calls[0]?.[0]).toHaveLength(498)

    // Hiding Qwen's last shown model does not move Qwen away under the pointer.
    rerenderHidden(hiddenExcept(0))
    expect(labNames(container).slice(0, 3)).toEqual(['DeepSeek', 'Qwen', 'Anthropic'])
    expect(screen.getByRole('button', { name: 'Qwen', expanded: true })).toBe(qwen)
  })

  it('searches every lab and acts on the matches only', async () => {
    const { container, onModelsVisibilityChange } = renderSection()

    search('gpt')
    const openAi = await screen.findByRole('button', { name: 'OpenAI', expanded: true })
    expect(labNames(container)).toEqual(['OpenAI'])
    expect(openAi.closest('.set-row')?.querySelector('.model-lab__count')?.textContent).toBe(
      '0 of 2',
    )
    expect(screen.getAllByRole('switch').map((entry) => entry.getAttribute('aria-label'))).toEqual([
      'Include GPT-6.1 Sol in model picker',
      'Include GPT-6 Luna in model picker',
    ])
    // The note still counts the whole source.
    expect(screen.getByText('2 of 500 shown in the model picker.')).toBeTruthy()

    fireEvent.click(
      screen.getByRole('button', { name: 'Show all matching OpenCode models in model picker' }),
    )
    expect(onModelsVisibilityChange).toHaveBeenCalledOnce()
    expect(onModelsVisibilityChange).toHaveBeenCalledWith([keyOf(2), keyOf(12)], true)

    // A lab closed during a search opens again for the next one.
    fireEvent.click(openAi)
    expect(screen.queryAllByRole('switch')).toEqual([])
    search('gpt-6')
    expect(await screen.findAllByRole('switch')).toHaveLength(2)

    // The lab a source declares finds models whose names do not carry it.
    search('google')
    expect(
      await screen.findByRole('switch', { name: 'Include Gemini 4 Argon in model picker' }),
    ).toBeTruthy()
    expect(labNames(container)).toEqual(['Google'])

    search('nothing-like-this')
    expect(await screen.findByText('No OpenCode models match “nothing-like-this”.')).toBeTruthy()
    expect(
      (
        screen.getByRole('button', {
          name: 'Show all matching OpenCode models in model picker',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)

    // Clearing the search folds every lab again.
    search('')
    expect(await screen.findByRole('button', { name: 'Other', expanded: false })).toBeTruthy()
    expect(screen.queryAllByRole('switch')).toEqual([])
  })

  it('folds a source without labs into one group without a second All and None', () => {
    const unlabeled = Array.from({ length: 25 }, (_, index) => choice(index, undefined))
    const { container } = renderSection({ choices: unlabeled, hidden: new Set() })

    fireEvent.click(labToggle('All models'))
    expect(screen.getByRole('group', { name: 'All models' })).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(25)
    expect(container.querySelectorAll('.model-visibility__bulk-actions')).toHaveLength(1)
    expect(screen.getByText('25 of 25 shown in the model picker.')).toBeTruthy()
  })
})
