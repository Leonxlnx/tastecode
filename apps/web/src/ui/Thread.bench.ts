import { bench, describe } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import {
  activeTurnActivityIndices,
  activeTurnIsSearching,
  emptyThread,
  reduce,
  reduceDeltas,
  reduceEventLog,
  threadItemAt,
  threadItemById,
  type ItemDeltaEvent,
  type ThreadState,
} from '../thread-store.js'
import { makeFixtureThread } from './fixture.js'
import { createThreadProjector, projectThreadItems } from './turns.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const FAST_OPTIONS = { iterations: 1_000_000, time: 0, warmupIterations: 100_000, warmupTime: 0 }
const ITEM_COUNTS = [1_000, 10_000] as const
const transcript = makeFixtureThread(1_000)

const liveItem: Item = {
  id: 'live-item',
  turnId: 'live-turn',
  type: 'message',
  role: 'assistant',
  status: 'started',
  text: '',
  createdAt: 0,
}

const streamingState: ThreadState = {
  ...emptyThread,
  items: [...transcript, liveItem],
  running: true,
  activeTurn: { id: liveItem.turnId, startedAt: 0 },
}
const streamedFrames = [streamingState.items, [...transcript, { ...liveItem, text: 'next frame' }]]
const searchingTranscript: Item[] = [
  ...transcript,
  {
    id: 'active-search',
    turnId: 'active-turn',
    type: 'tool_call',
    status: 'started',
    text: 'search files',
    createdAt: 0,
  },
]
const completedActivityTail: Item[] = [
  ...Array.from({ length: 10_000 }, (_, index) => ({
    id: `completed-tool-${index}`,
    turnId: 'long-active-turn',
    type: 'tool_call' as const,
    status: 'completed' as const,
    text: 'read file',
    createdAt: index,
  })),
  {
    id: 'streaming-answer',
    turnId: 'long-active-turn',
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'started' as const,
    text: 'Writing the answer',
    createdAt: 10_000,
  },
]
const completedActivityTailIndex = activeTurnActivityIndices(
  completedActivityTail,
  'long-active-turn',
)
const projectThread = createThreadProjector()
projectThread(streamedFrames[0]!)
let streamedFrame = 0

const deltas: ItemDeltaEvent[] = Array.from({ length: 500 }, () => ({
  type: 'item.delta',
  turnId: liveItem.turnId,
  itemId: liveItem.id,
  textDelta: 'x',
}))

function makeReplayEntries(itemCount: number): Array<{ seq: number; event: DomainEvent }> {
  const entries: Array<{ seq: number; event: DomainEvent }> = []
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const id = `history-${itemIndex}`
    entries.push({
      seq: entries.length + 1,
      event: {
        type: 'item.started',
        item: {
          id,
          turnId: `turn-${itemIndex}`,
          type: 'message',
          role: 'assistant',
          status: 'started',
          text: '',
          createdAt: itemIndex,
        },
      },
    })
    for (let deltaIndex = 0; deltaIndex < 50; deltaIndex += 1) {
      entries.push({
        seq: entries.length + 1,
        event: {
          type: 'item.delta',
          turnId: `turn-${itemIndex}`,
          itemId: id,
          textDelta: 'x',
        },
      })
    }
    entries.push({
      seq: entries.length + 1,
      event: {
        type: 'item.completed',
        item: {
          id,
          turnId: `turn-${itemIndex}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          text: 'x'.repeat(50),
          createdAt: itemIndex,
        },
      },
    })
  }
  return entries
}

const replayEntries = new Map(ITEM_COUNTS.map((count) => [count, makeReplayEntries(count)]))

const activityFrames = new Map(
  ITEM_COUNTS.map((count) => {
    const history = makeFixtureThread(count)
    const command: Item = {
      id: `command-${count}`,
      turnId: `live-${count}`,
      type: 'command',
      status: 'started',
      command: 'pnpm test',
      text: '',
      createdAt: 0,
    }
    const tool: Item = {
      id: `tool-${count}`,
      turnId: command.turnId,
      type: 'tool_call',
      status: 'started',
      text: 'search',
      createdAt: 0,
    }
    const state: ThreadState = {
      ...emptyThread,
      items: [...history, command, tool],
      running: true,
      activeTurn: { id: command.turnId, startedAt: 0 },
    }
    const frame: ItemDeltaEvent[] = [
      { type: 'item.delta', turnId: command.turnId, itemId: command.id, textDelta: 'output' },
      { type: 'item.delta', turnId: tool.turnId, itemId: tool.id, textDelta: ' result' },
    ]
    return [count, { state, frame }] as const
  }),
)
const completionItems = [...makeFixtureThread(9_999), liveItem]
const completionIndex = completionItems.length - 1
const completionState: ThreadState = {
  ...emptyThread,
  items: completionItems,
  liveItems: new Map([
    [
      completionIndex,
      {
        item: { ...liveItem, text: 'streamed answer' },
        version: 1,
        textUpdate: { kind: 'append', text: 'streamed answer' },
      },
    ],
  ]),
  itemVersion: 1,
  running: true,
  activeTurn: { id: liveItem.turnId, startedAt: 0 },
}
const completionEvent = {
  type: 'item.completed',
  item: { ...liveItem, status: 'completed', text: '' },
} satisfies DomainEvent
const structuralPrefix = makeFixtureThread(9_999)
const structuralTurnId = structuralPrefix.at(-1)!.turnId
const structuralTool: Item = {
  id: 'structural-tail-tool',
  turnId: structuralTurnId,
  type: 'tool_call',
  status: 'started',
  text: 'Reading files',
  createdAt: 0,
}
const structuralFrames = [
  [...structuralPrefix, structuralTool],
  [...structuralPrefix, { ...structuralTool, status: 'completed' as const }],
]
const projectStructuralTail = createThreadProjector()
projectStructuralTail(structuralFrames[0]!)
let structuralFrame = 0
const timingTurnId = structuralFrames[0]!.at(-1)!.turnId
const timingFrames = [
  { [timingTurnId]: { startedAt: 0, completedAt: 1 } },
  { [timingTurnId]: { startedAt: 0, completedAt: 2 } },
]
const projectStructuralTiming = createThreadProjector()
projectStructuralTiming(structuralFrames[0]!, timingFrames[0])
let timingFrame = 0
const durableLookupState: ThreadState = { ...emptyThread, items: makeFixtureThread(10_000) }
const durableLookupIds = durableLookupState.items
  .filter((_, index) => index % 100 === 0)
  .map((item) => item.id)
threadItemById(durableLookupState, durableLookupIds[0]!)

function legacyCompleteStreamedItem(state: ThreadState): ThreadState {
  const settledItems = state.items.slice()
  for (const [index, update] of state.liveItems) settledItems[index] = update.item
  const index = settledItems.findIndex((item) => item.id === completionEvent.item.id)
  const items = settledItems.slice()
  const streamed = items[index]?.text
  items[index] = { ...completionEvent.item, text: streamed }
  return { ...state, items, liveItems: new Map() }
}

describe('long-thread hot paths', () => {
  bench(
    'derives navigation and presentation in one pass for 1,000 items',
    () => {
      projectThreadItems(transcript)
    },
    OPTIONS,
  )

  bench(
    'projects a streamed tail update in a 1,000-item thread',
    () => {
      streamedFrame = streamedFrame === 0 ? 1 : 0
      projectThread(streamedFrames[streamedFrame]!)
    },
    FAST_OPTIONS,
  )

  bench(
    'detects active search in a 1,000-item thread',
    () => {
      if (!activeTurnIsSearching(searchingTranscript, 'active-turn')) {
        throw new Error('search state missing')
      }
    },
    FAST_OPTIONS,
  )

  bench(
    'scans 10,000 completed activity rows for active search',
    () => {
      if (activeTurnIsSearching(completedActivityTail, 'long-active-turn')) {
        throw new Error('unexpected search state')
      }
    },
    OPTIONS,
  )

  bench(
    'checks the indexed live activity rows in a 10,000-item turn',
    () => {
      if (
        activeTurnIsSearching(
          completedActivityTail,
          'long-active-turn',
          undefined,
          0,
          completedActivityTailIndex,
        )
      ) {
        throw new Error('unexpected indexed search state')
      }
    },
    FAST_OPTIONS,
  )

  bench(
    'folds 500 live deltas into a 1,000-item thread',
    () => {
      let state = streamingState
      for (const event of deltas) state = reduce(state, event)
      if (
        threadItemAt(state.items, state.liveItems, state.items.length - 1)?.text?.length !==
        deltas.length
      )
        throw new Error('invalid fold')
    },
    OPTIONS,
  )

  bench(
    'folds a 500-delta frame into a 1,000-item thread',
    () => {
      const state = reduceDeltas(streamingState, deltas)
      if (
        threadItemAt(state.items, state.liveItems, state.items.length - 1)?.text?.length !==
        deltas.length
      )
        throw new Error('invalid batch')
    },
    OPTIONS,
  )

  bench(
    'finishes a streamed item with a double copy and linear lookup in 10,000 items',
    () => {
      const state = legacyCompleteStreamedItem(completionState)
      if (state.items[completionIndex]?.text !== 'streamed answer') throw new Error('invalid item')
    },
    OPTIONS,
  )

  bench(
    'finishes a streamed item with one copy and retained lookup in 10,000 items',
    () => {
      const state = reduce(completionState, completionEvent)
      if (state.items[completionIndex]?.text !== 'streamed answer') throw new Error('invalid item')
    },
    OPTIONS,
  )

  bench(
    'scans a 10,000-item thread for 100 pending submissions',
    () => {
      let found = 0
      for (const id of durableLookupIds) {
        if (durableLookupState.items.some((item) => item.id === id && item.turnId !== '')) {
          found += 1
        }
      }
      if (found !== durableLookupIds.length) throw new Error('invalid linear lookup')
    },
    OPTIONS,
  )

  bench(
    'builds a 10,000-item durable set before reconciling 100 pending submissions',
    () => {
      const durable = new Set(
        durableLookupState.items.filter((item) => item.turnId !== '').map((item) => item.id),
      )
      let found = 0
      for (const id of durableLookupIds) if (durable.has(id)) found += 1
      if (found !== durableLookupIds.length) throw new Error('invalid durable set')
    },
    OPTIONS,
  )

  bench(
    'uses the retained item index for 100 pending submissions',
    () => {
      let found = 0
      for (const id of durableLookupIds) {
        if ((threadItemById(durableLookupState, id)?.turnId ?? '') !== '') found += 1
      }
      if (found !== durableLookupIds.length) throw new Error('invalid indexed lookup')
    },
    OPTIONS,
  )

  bench(
    'rebuilds a fresh thread projection for a structural tail update in 10,000 items',
    () => {
      structuralFrame = structuralFrame === 0 ? 1 : 0
      projectThreadItems(structuralFrames[structuralFrame]!)
    },
    OPTIONS,
  )

  bench(
    'reprojects only the retained tail turn in 10,000 items',
    () => {
      structuralFrame = structuralFrame === 0 ? 1 : 0
      projectStructuralTail(structuralFrames[structuralFrame]!)
    },
    OPTIONS,
  )

  bench(
    'rebuilds a fresh thread projection for one timing update in 10,000 items',
    () => {
      timingFrame = timingFrame === 0 ? 1 : 0
      projectThreadItems(structuralFrames[0]!, timingFrames[timingFrame])
    },
    OPTIONS,
  )

  bench(
    'rebuilds projected turn metadata for one timing update in 10,000 items',
    () => {
      timingFrame = timingFrame === 0 ? 1 : 0
      projectStructuralTiming(structuralFrames[0]!, timingFrames[timingFrame])
    },
    OPTIONS,
  )

  for (const count of ITEM_COUNTS) {
    bench(
      `folds command and tool deltas into a ${count.toLocaleString('en-US')}-item history`,
      () => {
        const fixture = activityFrames.get(count)!
        const state = reduceDeltas(fixture.state, fixture.frame)
        if (
          !threadItemAt(state.items, state.liveItems, state.items.length - 2)?.text?.endsWith(
            'output',
          )
        ) {
          throw new Error('invalid command fold')
        }
        if (
          !threadItemAt(state.items, state.liveItems, state.items.length - 1)?.text?.endsWith(
            ' result',
          )
        )
          throw new Error('invalid activity fold')
      },
      OPTIONS,
    )

    bench(
      `replays ${(count * 52).toLocaleString('en-US')} persisted events into a ${count.toLocaleString('en-US')}-item thread`,
      () => {
        const state = reduceEventLog(emptyThread, replayEntries.get(count)!)
        if (state.items.length !== count) throw new Error('invalid replay')
      },
      OPTIONS,
    )
  }
})
