import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, bench, describe } from 'vitest'
import type { DomainEvent } from '@harness/contracts'
import { readHistoryPage } from './history-page.js'
import { compactHistoryReplay } from './history-replay.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'

const OPTIONS = { iterations: 10, time: 0, warmupIterations: 2, warmupTime: 0 }
const THREAD = 'long-thread'
const TURNS = 125

/**
 * A long working session: each turn streams reasoning and a reply, runs four
 * commands (every other turn one with ~30 KB of output), edits two files and
 * reports usage, plans and the turn diff. 125 turns write just over 10,000 events.
 */
function turnEvents(index: number): DomainEvent[] {
  const turnId = `turn-${index}`
  const events: DomainEvent[] = [
    {
      type: 'turn.started',
      turn: { id: turnId, threadId: THREAD, status: 'running', createdAt: index },
    },
    {
      type: 'item.completed',
      item: {
        id: `prompt-${index}`,
        turnId,
        type: 'message',
        role: 'user',
        status: 'completed',
        text: `Turn ${index}: fix the failing tests and explain the change.`,
        createdAt: index,
      },
    },
  ]
  const stream = (
    item: Extract<DomainEvent, { type: 'item.started' }>['item'],
    text: string,
    parts: number,
  ) => {
    events.push({ type: 'item.started', item })
    const size = Math.ceil(text.length / parts)
    for (let offset = 0; offset < text.length; offset += size) {
      events.push({
        type: 'item.delta',
        turnId,
        itemId: item.id,
        textDelta: text.slice(offset, offset + size),
      })
    }
    events.push({ type: 'item.completed', item: { ...item, status: 'completed', text } })
  }
  const line = (n: number) => `${String(n).padStart(5)}  src/module-${n % 17}.ts:${n % 400}  ok\n`
  const output = (lines: number) => Array.from({ length: lines }, (_, n) => line(n)).join('')
  stream(
    { id: `reasoning-${index}`, turnId, type: 'reasoning', status: 'started', createdAt: index },
    'Reading the failing test output before changing anything. '.repeat(12),
    8,
  )
  events.push({
    type: 'plan.updated',
    turnId,
    steps: [{ text: 'Reproduce', status: 'running' }],
  })
  for (const [command, lines] of [10, 40, 90, index % 2 === 0 ? 700 : 20].entries()) {
    stream(
      {
        id: `command-${index}-${command}`,
        turnId,
        type: 'command',
        status: 'started',
        command: 'pnpm vitest run',
        createdAt: index,
      },
      output(lines),
      6,
    )
  }
  let diff = ''
  for (let file = 0; file < 2; file += 1) {
    const patch = `--- a/src/f${file}.ts\n+++ b/src/f${file}.ts\n${'@@ -1,3 +1,4 @@\n-old line\n+new line\n context\n'.repeat(40)}`
    diff += patch
    const item = {
      id: `file-${index}-${file}`,
      turnId,
      type: 'file_change' as const,
      status: 'started' as const,
      path: `src/f${file}.ts`,
      createdAt: index,
    }
    events.push({ type: 'item.started', item })
    events.push({ type: 'item.completed', item: { ...item, status: 'completed', text: patch } })
    events.push({ type: 'diff.updated', turnId, diff })
  }
  for (let report = 0; report < 3; report += 1) {
    events.push({
      type: 'usage.updated',
      usage: {
        inputTokens: index * 3 + report,
        cachedInputTokens: 0,
        outputTokens: index,
        reasoningTokens: 0,
        totalTokens: index * 4 + report,
      },
    })
  }
  events.push({ type: 'plan.updated', turnId, steps: [{ text: 'Reproduce', status: 'done' }] })
  stream(
    {
      id: `reply-${index}`,
      turnId,
      type: 'message',
      role: 'assistant',
      status: 'started',
      createdAt: index,
    },
    '## Fixed\n\nThe handler now awaits the write before replying.\n\n'.repeat(50),
    25,
  )
  events.push({ type: 'turn.completed', turnId, status: 'completed', completedAt: index })
  return events
}

const store = new Store(':memory:')
store.addProject('/history')
store.addThread({ id: THREAD, projectPath: '/history', provider: 'codex', title: 'Long' })
const records = Array.from({ length: TURNS }, (_, index) => turnEvents(index))
  .flat()
  .map((event) => ({ threadId: THREAD, event }))
for (let offset = 0; offset < records.length; offset += 500) {
  store.appendBatchWithSerializedEvents(records.slice(offset, offset + 500))
}
if (records.length < 10_000) throw new Error('fixture must exceed 10,000 events')
const replay = compactHistoryReplay(store.history(THREAD))
let encodedCharacters = 0

afterAll(() => store.close())

describe(`opening a ${records.length.toLocaleString('en-US')}-event thread`, () => {
  bench(
    'cold: parses every event, compacts and encodes the full replay',
    () => {
      encodedCharacters += JSON.stringify(compactHistoryReplay(store.history(THREAD))).length
    },
    OPTIONS,
  )

  bench(
    'cold: parses every event, compacts and encodes the newest page',
    () => {
      const page = readHistoryPage(THREAD, compactHistoryReplay(store.history(THREAD)), {})
      encodedCharacters += JSON.stringify(page.events).length
    },
    OPTIONS,
  )

  bench(
    'warm: encodes the cached full replay',
    () => {
      encodedCharacters += JSON.stringify(replay).length
    },
    OPTIONS,
  )

  bench(
    'warm: cuts and encodes the newest page from the cached replay',
    () => {
      encodedCharacters += JSON.stringify(readHistoryPage(THREAD, replay, {}).events).length
    },
    OPTIONS,
  )
})

// The same thread in a file database behind the orchestrator, while its next
// turn streams: every page request follows a freshly written delta.
const directory = mkdtempSync(path.join(os.tmpdir(), 'harness-history-page-bench-'))
const fileStore = new Store(path.join(directory, 'history.db'))
fileStore.addProject('/history')
fileStore.addThread({ id: THREAD, projectPath: '/history', provider: 'codex', title: 'Long' })
for (let offset = 0; offset < records.length; offset += 500) {
  fileStore.appendBatchWithSerializedEvents(records.slice(offset, offset + 500))
}
const orchestrator = new Orchestrator(fileStore, {
  onEvent: () => undefined,
  onLog: () => undefined,
  onLogin: () => undefined,
})
const liveTurn = `turn-${TURNS}`
fileStore.append(THREAD, {
  type: 'turn.started',
  turn: { id: liveTurn, threadId: THREAD, status: 'running', createdAt: TURNS },
})
fileStore.append(THREAD, {
  type: 'item.started',
  item: {
    id: 'live-reply',
    turnId: liveTurn,
    type: 'message',
    role: 'assistant',
    status: 'started',
    createdAt: TURNS,
  },
})
const newest = await orchestrator.historyPage(THREAD, { turnLimit: 10 })
const olderCursor = newest.page.olderCursor!

afterAll(async () => {
  await orchestrator.disposeAll()
  fileStore.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('older pages while a turn streams', () => {
  bench(
    'writes one delta, then reads the twenty turns above the newest page',
    async () => {
      fileStore.append(THREAD, {
        type: 'item.delta',
        turnId: liveTurn,
        itemId: 'live-reply',
        textDelta: 'more ',
      })
      const page = await orchestrator.historyPage(THREAD, { before: olderCursor, turnLimit: 20 })
      encodedCharacters += JSON.stringify(page.events).length
    },
    OPTIONS,
  )
})
