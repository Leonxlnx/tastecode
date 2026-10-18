// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Model } from '@harness/contracts'
import type { ModelChoice } from '../model-catalog.js'
import { ModelSelector } from './ModelSelector.js'

vi.mock('../haptics.js', () => ({ performAppHaptic: vi.fn(), prepareAppHaptics: vi.fn() }))

const MODEL: Model = {
  id: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol',
  description: 'Best for broad tasks',
  isDefault: true,
  reasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
}
const MODELS: ModelChoice[] = [
  { key: 'codex:gpt-5.6-sol', provider: 'codex', sourceName: 'Codex', mark: 'openai', model: MODEL },
]

afterEach(() => {
  cleanup()
  delete (window as { requestIdleCallback?: unknown }).requestIdleCallback
  delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback
})

it('loads the picker panel in an idle moment, so its first open has nothing to load', async () => {
  const idle: IdleRequestCallback[] = []
  Object.assign(window, {
    requestIdleCallback: (callback: IdleRequestCallback) => idle.push(callback),
    cancelIdleCallback: () => {},
  })
  const selector = (
    <ModelSelector
      models={MODELS}
      modelId="codex:gpt-5.6-sol"
      effort="medium"
      disabled={false}
      onModelChange={() => {}}
      onEffortChange={() => {}}
      onServiceTierChange={() => {}}
    />
  )
  render(
    <>
      {selector}
      {selector}
    </>,
  )

  // One preload for the app, however many selectors are on screen.
  expect(idle).toHaveLength(1)
  idle[0]!({ didTimeout: false, timeRemaining: () => 10 })
  await vi.dynamicImportSettled()

  fireEvent.click(screen.getAllByRole('button', { name: 'Model and reasoning' })[0]!)
  expect(screen.getByRole('searchbox', { name: 'Search models' })).toBeTruthy()
  expect(screen.queryByText('Loading models…')).toBeNull()
})
