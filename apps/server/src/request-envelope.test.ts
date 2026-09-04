import { describe, expect, it } from 'vitest'
import { parseFrequentMethodParams, parseRequestEnvelope } from './request-envelope.js'

describe('request envelope parsing', () => {
  it('keeps only the validated wire fields', () => {
    expect(
      parseRequestEnvelope({ id: '1', method: 'system.info', params: {}, ignored: true }),
    ).toEqual({ id: '1', method: 'system.info', params: {} })
  })

  it('rejects incomplete and mistyped envelopes', () => {
    expect(parseRequestEnvelope({ id: '1', method: 'system.info' })).toBeUndefined()
    expect(parseRequestEnvelope({ id: 1, method: 'system.info', params: {} })).toBeUndefined()
    expect(parseRequestEnvelope(null)).toBeUndefined()
  })

  it('validates common terminal input and resize parameters', () => {
    expect(
      parseFrequentMethodParams('terminal.input', {
        terminalId: 'terminal-1',
        data: 'x',
        ignored: true,
      }),
    ).toEqual({ terminalId: 'terminal-1', data: 'x' })
    expect(
      parseFrequentMethodParams('terminal.resize', {
        terminalId: 'terminal-1',
        columns: 120,
        rows: 40,
      }),
    ).toEqual({ terminalId: 'terminal-1', columns: 120, rows: 40 })
    expect(
      parseFrequentMethodParams('terminal.resize', {
        terminalId: 'terminal-1',
        columns: 0,
        rows: 40,
      }),
    ).toBeUndefined()
  })
})
