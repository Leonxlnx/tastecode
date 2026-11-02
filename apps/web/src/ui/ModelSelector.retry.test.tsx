// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Model } from '@harness/contracts'
import type { ModelChoice } from '../model-catalog.js'
import { ModelSelector } from './ModelSelector.js'

vi.mock('../haptics.js', () => ({ performAppHaptic: vi.fn(), prepareAppHaptics: vi.fn() }))

const load = vi.hoisted(() => ({ fail: true, attempts: 0 }))
vi.mock('./ModelSelectorPanel.js', async (importOriginal) => {
  load.attempts += 1
  if (load.fail) throw new Error('chunk missing')
  return importOriginal()
})

const MODEL: Model = {
  id: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol',
  description: 'Best for broad tasks',
  isDefault: true,
  reasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  serviceTiers: [],
}
const MODELS: ModelChoice[] = [
  {
    key: 'codex:gpt-5.6-sol',
    provider: 'codex',
    sourceName: 'Codex',
    mark: 'openai',
    model: MODEL,
  },
]

afterEach(() => {
  cleanup()
  delete (window as { requestIdleCallback?: unknown }).requestIdleCallback
  delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback
})

it('imports the picker panel again on open after the idle preload failed', async () => {
  const idle: IdleRequestCallback[] = []
  Object.assign(window, {
    requestIdleCallback: (callback: IdleRequestCallback) => idle.push(callback),
    cancelIdleCallback: () => {},
  })
  render(
    <ModelSelector
      models={MODELS}
      modelId="codex:gpt-5.6-sol"
      effort="medium"
      serviceTier={undefined}
      disabled={false}
      onModelChange={() => {}}
      onEffortChange={() => {}}
      onServiceTierChange={() => {}}
    />,
  )
  idle[0]!({ didTimeout: false, timeRemaining: () => 10 })
  await vi.dynamicImportSettled()
  expect(load.attempts).toBe(1)

  load.fail = false
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning' }))
    await vi.dynamicImportSettled()
  })

  expect(load.attempts).toBe(2)
  expect(
    await screen.findByRole('searchbox', { name: 'Search models' }, { timeout: 15_000 }),
  ).toBeTruthy()
})
