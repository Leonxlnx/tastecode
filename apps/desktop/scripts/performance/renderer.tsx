import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Item } from '@harness/contracts'
import { Thread } from '../../../web/src/ui/Thread.js'
import { makeFixtureThread } from '../../../web/src/ui/fixture.js'
import { ThreadFrameStore } from '../../../web/src/thread-frame-store.js'
import { emptyThread, reduce, threadItemAt } from '../../../web/src/thread-store.js'
import '../../../web/src/styles/tokens.css'
import '../../../web/src/styles/app.css'
import './style.css'

const params = new URLSearchParams(location.search)
const fixtureSize = (name: string, fallback: number, maximum: number) => {
  const value = Number(params.get(name) ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`Fixture parameter ${name} must be an integer from 1 to ${maximum}`)
  return value
}
const MESSAGE_COUNT = fixtureSize('messages', 500, 100_000)
const SESSION_COUNT = fixtureSize('sessions', 5, 100)
const STREAM_BATCHES = fixtureSize('batches', 120, 10_000)
const noop = () => undefined
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
const paint = async () => {
  await frame()
  await frame()
}

function fixture(seed: number): Item[] {
  let messages = 0
  const items: Item[] = []
  for (const item of makeFixtureThread(MESSAGE_COUNT * 4, seed)) {
    if (item.type === 'message') messages += 1
    items.push(item)
    if (messages === MESSAGE_COUNT) break
  }
  if (messages !== MESSAGE_COUNT) throw new Error(`Fixture must contain ${MESSAGE_COUNT} messages`)
  return items
}

const stores = Array.from(
  { length: SESSION_COUNT },
  (_, index) =>
    new ThreadFrameStore({
      ...emptyThread,
      items: fixture(index + 7),
    }),
)
function Fixture() {
  const [active, setActive] = useState(-1)
  return (
    <div className="performance-fixture">
      <nav aria-label="Fixture sessions">
        {stores.map((_, index) => (
          <button key={index} onClick={() => setActive(index)}>
            Session {index + 1}
          </button>
        ))}
      </nav>
      {active >= 0 ? (
        <Thread
          key={active}
          threadId={`fixture-${active}`}
          frameStore={stores[active]!}
          onDecide={noop}
          onAnswerUserInput={noop}
        />
      ) : (
        <p>Ready to open the {MESSAGE_COUNT}-message fixture.</p>
      )}
    </div>
  )
}

function scroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.thread')
  if (!element || element.clientHeight < 300 || element.scrollHeight <= element.clientHeight) {
    throw new Error('The real thread must have browser layout and scrollable content')
  }
  return element
}

function visibleRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.thread__row')).filter((row) => {
    const rect = row.getBoundingClientRect()
    return (
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      row.textContent!.trim().length > 0
    )
  })
}

async function switchTo(index: number): Promise<number> {
  const start = performance.now()
  document.querySelectorAll<HTMLButtonElement>('nav button')[index]!.click()
  await paint()
  if (visibleRows().length === 0) throw new Error('No real message was painted')
  return performance.now() - start
}

async function scrollAll() {
  const seen = new Set<number>()
  const frames: number[] = []
  const element = scroller()
  // Reset the real virtualizer before measuring uninterrupted scroll frames.
  element.scrollTop = 0
  element.dispatchEvent(new Event('scroll'))
  await paint()
  let previous = await frame()
  let bottomFrames = 0
  for (let step = 0; step < 2_000; step += 1) {
    const now = await frame()
    frames.push(now - previous)
    previous = now
    for (const row of visibleRows()) seen.add(Number(row.dataset.index))
    const bottom = element.scrollTop >= element.scrollHeight - element.clientHeight - 2
    bottomFrames = bottom ? bottomFrames + 1 : 0
    if (bottomFrames >= 3) break
    element.scrollTop = Math.min(
      element.scrollTop + element.clientHeight * 0.65,
      element.scrollHeight,
    )
  }
  const seenMessages = [...seen].filter(
    (index) => stores[0]!.getSnapshot().items[index]?.type === 'message',
  ).length
  if (seenMessages !== MESSAGE_COUNT)
    throw new Error(`Only ${seenMessages}/${MESSAGE_COUNT} messages reached the visible DOM`)
  return {
    frames,
    seenMessages,
    visitedRows: seen.size,
    renderedRows: document.querySelectorAll('.thread__row').length,
  }
}

async function stream() {
  const store = stores[0]!
  let snapshot = reduce(store.getSnapshot(), {
    type: 'turn.started',
    turn: {
      id: 'perf-live',
      threadId: 'fixture-0',
      status: 'running',
      createdAt: Date.now(),
    },
  })
  snapshot = reduce(snapshot, {
    type: 'item.started',
    item: {
      id: 'perf-live-answer',
      turnId: 'perf-live',
      type: 'message',
      role: 'assistant',
      status: 'started',
      text: 'Live answer: ',
      createdAt: Date.now(),
    },
  })
  flushSync(() => store.publish(snapshot))
  await paint()
  const element = scroller()
  element.scrollTop = element.scrollHeight
  await paint()
  const batches: number[] = []
  const frames: number[] = []
  let previous = await frame()
  for (let batch = 0; batch < STREAM_BATCHES; batch += 1) {
    const now = await frame()
    frames.push(now - previous)
    previous = now
    const start = performance.now()
    // Production reducers and frame subscriptions, including synchronous React
    // commit and layout. Sixteen deltas represent one provider frame burst.
    flushSync(() => {
      for (let delta = 0; delta < 16; delta += 1)
        snapshot = reduce(snapshot, {
          type: 'item.delta',
          turnId: 'perf-live',
          itemId: 'perf-live-answer',
          textDelta: 'text ',
        })
      store.publish(snapshot)
    })
    document.querySelector('.reply.is-streaming')?.getBoundingClientRect()
    batches.push(performance.now() - start)
  }
  await paint()
  const liveText = document.querySelector('.reply.is-streaming')?.textContent ?? ''
  if (!liveText.includes('text '.repeat(32)))
    throw new Error('Streaming did not reach the visible reply')
  snapshot = reduce(snapshot, {
    type: 'item.completed',
    item: {
      ...threadItemAt(snapshot.items, snapshot.liveItems, snapshot.items.length - 1)!,
      status: 'completed',
    },
  })
  snapshot = reduce(snapshot, {
    type: 'turn.completed',
    turnId: 'perf-live',
    status: 'completed',
    completedAt: Date.now(),
  })
  flushSync(() => store.publish(snapshot))
  return { batches, frames, deltas: STREAM_BATCHES * 16, visibleTextLength: liveText.length }
}

async function settleIdle() {
  let stable = 0
  for (let count = 0; count < 240; count += 1) {
    await frame()
    const running = document
      .getAnimations()
      .some((animation) => animation.playState === 'running' || animation.pending)
    stable = running ? 0 : stable + 1
    if (stable >= 3) return
  }
  throw new Error('Fixture animations did not settle before idle memory measurement')
}

async function run() {
  await document.fonts.ready
  await paint()
  const firstPaintMs = await switchTo(0)
  const initiallyVisible = visibleRows().length
  const scroll = await scrollAll()
  const streaming = await stream()
  const switches = []
  for (let index = 1; index < SESSION_COUNT; index += 1) switches.push(await switchTo(index))
  switches.push(await switchTo(0))
  await settleIdle()
  if (stores.some((store) => store.getSnapshot().running))
    throw new Error('Idle fixture still has an active turn')
  return {
    firstPaintMs,
    initiallyVisible,
    scroll,
    streaming,
    switches,
    sessions: stores.length,
    items: stores[0]!.getSnapshot().items.length,
    messageCount: MESSAGE_COUNT,
  }
}

createRoot(document.getElementById('root')!).render(<Fixture />)
Object.assign(window, { runPerformanceFixture: run })
