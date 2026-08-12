import type { Item } from '@harness/contracts'
import { render, type RenderResult } from '@testing-library/react'
import {
  beginOptimisticTurn,
  emptyThread,
  reduce,
  reduceDeltas,
  type ThreadState,
} from '../thread-store.js'
import { makeFixtureThread } from './fixture.js'
import { Thread } from './Thread.js'

export type PromptProgressScenario = {
  name: string
  historyItems: number
  liveCharacters: number
}

export const PROMPT_PROGRESS_SCENARIOS: PromptProgressScenario[] = [
  { name: 'short live reply', historyItems: 0, liveCharacters: 16 },
  { name: '4 KiB live reply', historyItems: 0, liveCharacters: 4_096 },
  { name: '64 KiB live reply', historyItems: 0, liveCharacters: 65_536 },
  { name: '1,000-item history', historyItems: 1_000, liveCharacters: 16 },
]

const SUBMISSION_ID = 'local:prompt-progress'
const TURN_ID = 'prompt-progress-turn'
const ANSWER_ID = 'prompt-progress-answer'
const CREATED_AT = 1_800_000
const PROMPT = 'Build the requested page and report the result.'
const HISTORIES = new Map([[1_000, makeFixtureThread(1_000)]])
const LIVE_DELTAS = new Map(
  PROMPT_PROGRESS_SCENARIOS.map(({ liveCharacters }) => [
    liveCharacters,
    ['x'.repeat(liveCharacters - 1), '!'] as const,
  ]),
)

function view(state: ThreadState) {
  return (
    <Thread
      items={state.items}
      running={state.running}
      activeTurn={state.activeTurn}
      turnTiming={state.turnTiming}
      plan={state.plan}
      diff={state.diff}
      approvals={state.approvals}
      userInputs={state.userInputs}
      reviews={Object.values(state.reviews)}
      onDecide={() => undefined}
      onAnswerUserInput={() => undefined}
    />
  )
}

function startingState(historyItems: number): ThreadState {
  if (historyItems === 0) return emptyThread
  const items = HISTORIES.get(historyItems)
  if (!items) throw new Error(`Missing ${historyItems}-item prompt progress fixture`)
  return { ...emptyThread, items }
}

export type PromptProgressRun = {
  rendered: RenderResult
  optimisticPrompt: Element
  optimisticRail: Element
  canonicalPrompt: Element
  canonicalRail: Element
  startedPrompt: Element
  startedRail: Element
  deltaPrompt: Element
  deltaRail: Element
  finalState: ThreadState
}

/** Drives the same reducer and renderer boundaries as a live submit without a provider or socket. */
export function runPromptProgress(scenario: PromptProgressScenario): PromptProgressRun {
  let state = beginOptimisticTurn(
    startingState(scenario.historyItems),
    PROMPT,
    SUBMISSION_ID,
    CREATED_AT,
  )
  const rendered = render(view(state))
  const optimisticPrompt = promptNode(rendered)
  const optimisticRail = oneWorkingRail(rendered)

  state = reduce(state, {
    type: 'turn.started',
    turn: {
      id: TURN_ID,
      threadId: 'prompt-progress-thread',
      status: 'running',
      createdAt: CREATED_AT + 1,
    },
  })
  state = reduce(state, {
    type: 'item.completed',
    item: {
      id: SUBMISSION_ID,
      turnId: TURN_ID,
      type: 'message',
      role: 'user',
      status: 'completed',
      text: PROMPT,
      createdAt: CREATED_AT + 1,
    },
  })
  rendered.rerender(view(state))
  const canonicalPrompt = promptNode(rendered)
  const canonicalRail = oneWorkingRail(rendered)

  state = reduce(state, {
    type: 'item.started',
    item: {
      id: ANSWER_ID,
      turnId: TURN_ID,
      type: 'message',
      role: 'assistant',
      status: 'started',
      text: '',
      createdAt: CREATED_AT + 2,
    },
  })
  rendered.rerender(view(state))
  const startedPrompt = promptNode(rendered)
  const startedRail = oneWorkingRail(rendered)

  const textDeltas = LIVE_DELTAS.get(scenario.liveCharacters)
  if (!textDeltas) throw new Error(`Missing ${scenario.liveCharacters}-character live fixture`)
  state = reduceDeltas(state, [
    {
      type: 'item.delta',
      turnId: TURN_ID,
      itemId: ANSWER_ID,
      textDelta: textDeltas[0],
    },
    { type: 'item.delta', turnId: TURN_ID, itemId: ANSWER_ID, textDelta: textDeltas[1] },
  ])
  rendered.rerender(view(state))
  const deltaPrompt = promptNode(rendered)

  return {
    rendered,
    optimisticPrompt,
    optimisticRail,
    canonicalPrompt,
    canonicalRail,
    startedPrompt,
    startedRail,
    deltaPrompt,
    deltaRail: oneWorkingRail(rendered),
    finalState: state,
  }
}

function promptNode(rendered: RenderResult): Element {
  const prompt = [...rendered.container.querySelectorAll('.said__text')].find(
    (node) => node.textContent === PROMPT,
  )
  return required(prompt, 'submitted prompt')
}

function oneWorkingRail(rendered: RenderResult): Element {
  const rails = rendered.container.querySelectorAll('.activity--working')
  if (rails.length !== 1) throw new Error(`Expected one Working rail, received ${rails.length}`)
  return rails[0]!
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${label}`)
  return value
}
