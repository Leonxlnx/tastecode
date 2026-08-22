// @vitest-environment happy-dom
import { bench, describe } from 'vitest'
import { channels, methods, PushSchema, ResponseSchema } from '@harness/contracts'
import { z } from 'zod'
import { parseIncomingFrame, parseResponseFrame } from './transport.js'
import { parseChannelData, parseMethodResult } from './transport-validation.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const FRAME_COUNT = 5_000
const LegacyErrorResponseSchema = z.object({
  id: z.string(),
  error: z
    .object({ message: z.string().min(1).optional(), detail: z.string().min(1).optional() })
    .passthrough(),
})
const WireResponseSchema = z.union([ResponseSchema, LegacyErrorResponseSchema])
const raw = JSON.stringify({
  channel: 'thread.event',
  sequence: 1,
  data: {
    threadId: 'thread-1',
    seq: 1,
    event: {
      type: 'item.delta',
      turnId: 'turn-1',
      itemId: 'answer-1',
      textDelta: 'x'.repeat(256),
    },
  },
})

function legacyParse(rawFrame: string): boolean {
  const value: unknown = JSON.parse(rawFrame)
  if (WireResponseSchema.safeParse(value).success) return false
  return PushSchema.safeParse(value).success
}

function routedZodParse(rawFrame: string): boolean {
  const value: unknown = JSON.parse(rawFrame)
  if (typeof value !== 'object' || value === null || !('channel' in value)) return false
  return PushSchema.safeParse(value).success
}

describe('streamed push frame parsing', () => {
  bench(
    'fails response validation before parsing each push',
    () => {
      let parsed = 0
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        if (legacyParse(raw)) parsed += 1
      }
      if (parsed !== FRAME_COUNT) throw new Error('missing push')
    },
    OPTIONS,
  )

  bench(
    'routes each push directly to its schema',
    () => {
      let parsed = 0
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        if (routedZodParse(raw)) parsed += 1
      }
      if (parsed !== FRAME_COUNT) throw new Error('missing push')
    },
    OPTIONS,
  )

  bench(
    'validates the small push envelope directly',
    () => {
      let parsed = 0
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        if (parseIncomingFrame(raw)?.kind === 'push') parsed += 1
      }
      if (parsed !== FRAME_COUNT) throw new Error('missing push')
    },
    OPTIONS,
  )
})

describe('streamed channel data validation', () => {
  const frame = JSON.parse(raw) as { data: unknown }
  const retained: unknown[] = Array.from({ length: FRAME_COUNT })

  bench(
    'validates 5,000 deltas through the general channel schema',
    () => {
      let parsed = 0
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        const result = channels['thread.event'].safeParse(frame.data)
        if (result.success) {
          retained[index] = result.data
          parsed += 1
        }
      }
      if (parsed !== FRAME_COUNT) throw new Error('missing push data')
    },
    OPTIONS,
  )

  bench(
    'validates 5,000 common deltas directly',
    () => {
      let parsed = 0
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        const result = parseChannelData('thread.event', frame.data)
        retained[index] = result
        if (result.event.type === 'item.delta') parsed += 1
      }
      if (parsed !== FRAME_COUNT) throw new Error('missing push data')
    },
    OPTIONS,
  )
})

describe('successful response envelope validation', () => {
  const response = { id: '123', result: { accepted: true } }

  bench(
    'validates 10,000 responses through the response union',
    () => {
      let parsed = 0
      for (let index = 0; index < 10_000; index += 1) {
        if (WireResponseSchema.safeParse(response).success) parsed += 1
      }
      if (parsed !== 10_000) throw new Error('missing responses')
    },
    OPTIONS,
  )

  bench(
    'validates 10,000 successful responses directly',
    () => {
      let parsed = 0
      for (let index = 0; index < 10_000; index += 1) {
        if (parseResponseFrame(response)) parsed += 1
      }
      if (parsed !== 10_000) throw new Error('missing responses')
    },
    OPTIONS,
  )
})

describe('terminal output validation', () => {
  const output = { terminalId: 'terminal-1', data: 'x'.repeat(4_096) }
  const retained: unknown[] = Array.from({ length: 10_000 })

  bench(
    'validates 10,000 terminal chunks through the channel schema',
    () => {
      let parsed = 0
      for (let index = 0; index < 10_000; index += 1) {
        const result = channels['terminal.output'].safeParse(output)
        if (result.success) {
          retained[index] = result.data
          parsed += 1
        }
      }
      if (parsed !== 10_000) throw new Error('missing terminal output')
    },
    OPTIONS,
  )

  bench(
    'validates 10,000 terminal chunks directly',
    () => {
      let parsed = 0
      for (let index = 0; index < 10_000; index += 1) {
        const result = parseChannelData('terminal.output', output)
        retained[index] = result
        if (result.data.length > 0) parsed += 1
      }
      if (parsed !== 10_000) throw new Error('missing terminal output')
    },
    OPTIONS,
  )
})

describe('many-thread project response validation', () => {
  const result = {
    projects: Array.from({ length: 100 }, (_, projectIndex) => ({
      path: `/project-${projectIndex}`,
      name: `Project ${projectIndex}`,
      pinned: projectIndex < 3,
      createdAt: projectIndex,
      sessions: Array.from({ length: 100 }, (_, sessionIndex) => ({
        id: `thread-${projectIndex}-${sessionIndex}`,
        title: `Thread ${sessionIndex}`,
        provider: 'codex',
        createdAt: sessionIndex,
        running: false,
        pinned: false,
        status: 'idle',
        unread: false,
        lifecycle: { state: 'active', keepActive: false },
      })),
    })),
  }

  bench(
    'validates and copies 10,000 rows through the result schema',
    () => {
      if (methods['projects.list'].result.parse(result).projects.length !== 100) {
        throw new Error('missing projects')
      }
    },
    OPTIONS,
  )

  bench(
    'validates 10,000 rows in place',
    () => {
      if (parseMethodResult('projects.list', result).projects.length !== 100) {
        throw new Error('missing projects')
      }
    },
    OPTIONS,
  )
})
