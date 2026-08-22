import { describe, expect, it } from 'vitest'
import { createSerializedResultCache, serializeSuccessResponse } from './response-serializer.js'

describe('response serializer', () => {
  it('encodes one immutable result once while request ids remain distinct', () => {
    const cache = createSerializedResultCache<{ projects: unknown[] }>()
    const value = { projects: [{ path: 'C:\\repo', name: 'A "quoted" project' }] }
    const first = cache(value)

    expect(cache(value)).toBe(first)
    expect(JSON.parse(serializeSuccessResponse('1', first))).toEqual({ id: '1', result: value })
    expect(JSON.parse(serializeSuccessResponse('2', first))).toEqual({ id: '2', result: value })
    const secondValue = { projects: [] }
    expect(cache(secondValue)).not.toBe(first)
    expect(cache(value)).toBe(first)
  })

  it('uses normal encoding for uncached results', () => {
    expect(serializeSuccessResponse('1', { ok: true })).toBe(
      JSON.stringify({ id: '1', result: { ok: true } }),
    )
  })
})
