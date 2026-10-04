import { bench, describe } from 'vitest'
import { methods, RequestSchema } from '@harness/contracts'
import { parseFrequentMethodParams, parseRequestEnvelope } from './request-envelope.js'

const OPTIONS = { iterations: 20, time: 0, warmupIterations: 5, warmupTime: 0 }
const FRAME_COUNT = 10_000
const envelope = {
  id: '123',
  method: 'terminal.input',
  params: { terminalId: 'terminal-1', data: 'x' },
}

describe('incoming request envelope validation', () => {
  bench(
    'validates 10,000 envelopes through the general schema',
    () => {
      let parsed = 0
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        if (RequestSchema.safeParse(envelope).success) parsed += 1
      }
      if (parsed !== FRAME_COUNT) throw new Error('missing requests')
    },
    OPTIONS,
  )

  bench(
    'validates 10,000 small envelopes directly',
    () => {
      let parsed = 0
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        if (parseRequestEnvelope(envelope)) parsed += 1
      }
      if (parsed !== FRAME_COUNT) throw new Error('missing requests')
    },
    OPTIONS,
  )
})

describe('terminal input parameter validation', () => {
  const params = envelope.params

  bench(
    'validates 10,000 terminal inputs through the method schema',
    () => {
      let parsed = 0
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        if (methods['terminal.input'].params.safeParse(params).success) parsed += 1
      }
      if (parsed !== FRAME_COUNT) throw new Error('missing terminal input')
    },
    OPTIONS,
  )

  bench(
    'validates 10,000 terminal inputs directly',
    () => {
      let parsed = 0
      for (let index = 0; index < FRAME_COUNT; index += 1) {
        if (parseFrequentMethodParams('terminal.input', params)) parsed += 1
      }
      if (parsed !== FRAME_COUNT) throw new Error('missing terminal input')
    },
    OPTIONS,
  )
})
