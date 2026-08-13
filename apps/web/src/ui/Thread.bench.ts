import { bench, describe } from 'vitest'
import type { DomainEvent, Item } from '@harness/contracts'
import {
  activeTurnIsSearching,
  emptyThread,
  reduce,
  reduceDeltas,
  reduceEventLog,
  threadItemAt,
  type ItemDeltaEvent,
  type ThreadState,
} from '../thread-store.js'
import { makeFixtureThread } from './fixture.js'
import { createThreadProjector, findTurns, presentTurns } from './turns.js'

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

describe('long-thread hot paths', () => {
  bench(
    'derives navigation and presentation for 1,000 items',
    () => {
      findTurns(transcript)
      presentTurns(transcript)
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
