import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { Item } from '@harness/contracts'
import { Thread } from '../../../web/src/ui/Thread.js'
import { ThreadFrameStore } from '../../../web/src/thread-frame-store.js'
import { emptyThread } from '../../../web/src/thread-store.js'

const TOOL_CALLS = 300
const OUTPUT_CHARACTERS = 128 * 1024
const noop = () => undefined
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))

let store: ThreadFrameStore | undefined
let root: Root | undefined
let host: HTMLElement | undefined

/** Distinct, flat output per call, so no row can share another row's text. */
function output(index: number): string {
  const lines: string[] = []
  let length = 0
  for (let line = 0; length < OUTPUT_CHARACTERS; line += 1) {
    const text = `${String(line).padStart(5)}  src/module-${index}/file-${line % 97}.ts:${(line * 31) % 900}  result ${index}.${line}`
    lines.push(text)
    length += text.length + 1
  }
  return lines.join('\n').slice(0, OUTPUT_CHARACTERS)
}

/** One finished turn: plain command output, plain tool output and JSON tool results. */
function items(): Item[] {
  const turnId = 'large-activity-turn'
  const list: Item[] = [
    {
      id: 'large-activity-prompt',
      turnId,
      type: 'message',
      role: 'user',
      status: 'completed',
      text: 'Inspect the large fixture',
      createdAt: 1,
    },
  ]
  for (let index = 0; index < TOOL_CALLS; index += 1) {
    const text = output(index)
    const base = {
      id: `large-activity-${index}`,
      turnId,
      status: 'completed' as const,
      createdAt: index + 2,
    }
    list.push(
      index % 3 === 0
        ? { ...base, type: 'command', command: `pnpm test case-${index}`, text, exitCode: 0 }
        : {
            ...base,
            type: 'tool_call',
            text:
              index % 3 === 1
                ? `fixture.read\n{"index":${index}}\n${text}`
                : `fixture.mcp\n{"index":${index}}\n${JSON.stringify({ content: [{ type: 'text', text }] })}`,
          },
    )
  }
  list.push({
    id: 'large-activity-answer',
    turnId,
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    text: 'Fixture complete.',
    createdAt: TOOL_CALLS + 2,
  })
  return list
}

function census() {
  const activity = host?.querySelector('.activity')
  if (!host || !activity) throw new Error('The large activity fixture is not mounted')
  return {
    activityElements: activity.getElementsByTagName('*').length,
    toolRows: host.querySelectorAll('.activity__body .aux__row').length,
    openDetails: host.querySelectorAll('.aux__reveal-clip').length,
    textCharacters: host.textContent?.length ?? 0,
  }
}

/** Disclosures settle on transitionend, or on their timeout fallback. */
async function settle() {
  const deadline = performance.now() + 2_000
  await frame()
  while (
    host?.querySelector('[data-open="opening"], [data-open="closing"]') &&
    performance.now() < deadline
  )
    await frame()
  await frame()
}

function click(selector: string) {
  const button = host?.querySelector<HTMLButtonElement>(selector)
  if (!button) throw new Error(`Missing ${selector}`)
  flushSync(() => button.click())
}

/**
 * Steps run one at a time so the main process can collect garbage and read the
 * heap between them. The store exists before the transcript mounts, so heap
 * deltas exclude the 37.5 MiB of item text itself.
 */
const largeActivitySteps = {
  prepare() {
    store = new ThreadFrameStore({ ...emptyThread, items: items() })
    return { toolCalls: TOOL_CALLS, outputCharacters: TOOL_CALLS * OUTPUT_CHARACTERS }
  },
  async mount() {
    if (!store) throw new Error('Prepare the large activity fixture first')
    host = document.createElement('section')
    host.className = 'large-activity-fixture'
    document.body.append(host)
    root = createRoot(host)
    flushSync(() =>
      root!.render(
        <Thread
          threadId="large-activity"
          frameStore={store!}
          onDecide={noop}
          onAnswerUserInput={noop}
        />,
      ),
    )
    await settle()
    return census()
  },
  async openOne() {
    click('.activity__summary')
    await settle()
    click('.activity__body .aux__row')
    await settle()
    return census()
  },
  async close() {
    click('.activity__summary')
    await settle()
    return census()
  },
  unmount() {
    flushSync(() => root?.unmount())
    host?.remove()
    root = undefined
    host = undefined
    store = undefined
  },
}

export type LargeActivityStep = keyof typeof largeActivitySteps

export async function runLargeActivityStep(step: LargeActivityStep): Promise<unknown> {
  return largeActivitySteps[step]()
}
