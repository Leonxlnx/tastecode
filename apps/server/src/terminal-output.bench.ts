import { bench, describe } from 'vitest'
import { TerminalOutputBuffer, TerminalOutputScheduler } from './terminal.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const TERMINAL_COUNT = 1_000
const OUTPUT_CHUNK_COUNT = 100_000
const INTERACTIVE_WINDOW_COUNT = 100_000
const OUTPUT_BATCH_SIZE = 64 * 1024
const OUTPUT_CHUNK = 'terminal output '
let serializedOutputLength = 0

function aggregateOutputWithChunkArrays(): void {
  let chunks: string[] = []
  let length = 0
  for (let index = 0; index < OUTPUT_CHUNK_COUNT; index += 1) {
    chunks.push(OUTPUT_CHUNK)
    length += OUTPUT_CHUNK.length
    if (length < OUTPUT_BATCH_SIZE) continue
    serializedOutputLength += JSON.stringify({ data: chunks.join('') }).length
    chunks = []
    length = 0
  }
  if (length > 0) serializedOutputLength += JSON.stringify({ data: chunks.join('') }).length
}

function aggregateOutputWithSingleChunkFastPath(): void {
  let chunks: string[] = []
  let length = 0
  for (let index = 0; index < OUTPUT_CHUNK_COUNT; index += 1) {
    chunks.push(OUTPUT_CHUNK)
    length += OUTPUT_CHUNK.length
    if (length < OUTPUT_BATCH_SIZE) continue
    const data = chunks.length === 1 ? chunks[0]! : chunks.join('')
    serializedOutputLength += JSON.stringify({ data }).length
    chunks = []
    length = 0
  }
  if (length > 0) {
    const data = chunks.length === 1 ? chunks[0]! : chunks.join('')
    serializedOutputLength += JSON.stringify({ data }).length
  }
}

function flushInteractiveOutputWithChunkArrays(): void {
  for (let index = 0; index < INTERACTIVE_WINDOW_COUNT; index += 1) {
    const chunks: string[] = []
    chunks.push(OUTPUT_CHUNK)
    serializedOutputLength += JSON.stringify({ data: chunks.join('') }).length
  }
}

function flushInteractiveOutputDirectly(): void {
  for (let index = 0; index < INTERACTIVE_WINDOW_COUNT; index += 1) {
    const chunks: string[] = []
    chunks.push(OUTPUT_CHUNK)
    const data = chunks.length === 1 ? chunks[0]! : chunks.join('')
    serializedOutputLength += JSON.stringify({ data }).length
  }
}

function schedulePerTerminalTimers(): void {
  const buffers = Array.from(
    { length: TERMINAL_COUNT },
    () => new TerminalOutputBuffer(() => undefined, 60_000),
  )
  for (const buffer of buffers) buffer.push('x')
  for (const buffer of buffers) buffer.dispose()
}

function scheduleSharedTimer(): void {
  const scheduler = new TerminalOutputScheduler(60_000)
  const buffers = Array.from(
    { length: TERMINAL_COUNT },
    () => new TerminalOutputBuffer(() => undefined, 60_000, 64 * 1024, scheduler),
  )
  for (const buffer of buffers) buffer.push('x')
  for (const buffer of buffers) buffer.dispose()
}

describe('many-terminal output scheduling', () => {
  bench('schedules one timer per 1,000 active terminals', schedulePerTerminalTimers, OPTIONS)
  bench('shares one timer across 1,000 active terminals', scheduleSharedTimer, OPTIONS)
})

describe('sustained terminal output aggregation', () => {
  bench('retains each PTY fragment in a chunk array', aggregateOutputWithChunkArrays, OPTIONS)
  bench(
    'checks the single-fragment fast path before joining',
    aggregateOutputWithSingleChunkFastPath,
    OPTIONS,
  )
})

describe('interactive terminal output aggregation', () => {
  bench(
    'allocates and joins a chunk array for one fragment',
    flushInteractiveOutputWithChunkArrays,
    OPTIONS,
  )
  bench('forwards the only fragment directly', flushInteractiveOutputDirectly, OPTIONS)
})
