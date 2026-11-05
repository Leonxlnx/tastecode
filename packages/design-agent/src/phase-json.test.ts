import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBrandPhaseOutput } from './brand-phase.js'
import { parsePhaseJson } from './phase-json.js'

// A real Brand answer from Codex (GPT-6 Luna Low, 2026-11-05) that closed the root object one
// brace early, right after designTokens, then went on with imageDirection, motionDirection and
// voice. Design mode failed with "Unexpected non-whitespace character after JSON at position
// 4022" after the same mistake in all four attempts.
const earlyClose = readFileSync(
  new URL('./fixtures/codex-brand-early-close.txt', import.meta.url),
  'utf8',
)

describe('phase JSON', () => {
  it('recovers an object closed one brace early, keeping the members after it', () => {
    expect(() => JSON.parse(earlyClose)).toThrow(/after JSON at position 4022/)
    const value = parsePhaseJson(earlyClose) as Record<string, unknown>
    expect(Object.keys(value)).toEqual(
      expect.arrayContaining(['designTokens', 'imageDirection', 'motionDirection', 'voice']),
    )
    expect(value['version']).toBe(1)
  })

  it('passes the recovered real answer through the Brand phase validation', () => {
    const brand = parseBrandPhaseOutput(earlyClose)
    expect(brand.typefaces[0]?.family).toBe('Onest')
    expect(brand.imageDirection.summary).toMatch(/natural-light/)
  })

  it('reads the JSON out of a fence or prose around it', () => {
    expect(parsePhaseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parsePhaseJson('Here is the result:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 })
    expect(parsePhaseJson('Here is the result: {"a":{"b":[1,2]}} and nothing else.')).toEqual({
      a: { b: [1, 2] },
    })
    expect(parsePhaseJson('{"a":1}\n{"a":2}')).toEqual({ a: 1 })
    expect(parsePhaseJson('Braces {like these} come first. {"a":"} not a close"}')).toEqual({
      a: '} not a close',
    })
  })

  it('still throws the parse error for an answer that holds no JSON', () => {
    expect(() => parsePhaseJson('I could not finish the brand.')).toThrow(SyntaxError)
    expect(() => parsePhaseJson('{"a":1,"b":')).toThrow(SyntaxError)
    // Truncated, not closed early: nothing after the close to continue with.
    expect(() => parsePhaseJson('{"a":{"b":1}')).toThrow(SyntaxError)
  })
})
