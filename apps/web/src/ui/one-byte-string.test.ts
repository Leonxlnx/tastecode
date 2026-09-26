import { describe, expect, it } from 'vitest'
import { createJavaScriptRegexEngine as createShikiJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { countWideGrammarScans, isOneByteString } from '../test-string-width.js'
import { oneByteString } from './one-byte-string.js'
import { createJavaScriptRegexEngine } from './shiki-bundle.js'

const REPLY = 'The loader retries once — see below.\nconst answer: number = 42 // café ±1'
const LINE = REPLY.slice(REPLY.indexOf('\n') + 1)

describe('one-byte strings', () => {
  it('stores Latin-1 text cut from a wider reply in one byte per character', () => {
    expect(isOneByteString(LINE)).toBe(false)

    const copy = oneByteString(LINE)

    expect(copy).toBe(LINE)
    expect(isOneByteString(copy)).toBe(true)
  })

  it('returns text with wider characters unchanged', () => {
    expect(oneByteString(REPLY)).toBe(REPLY)
    expect(isOneByteString(oneByteString(REPLY))).toBe(false)
  })

  it('copies lines longer than one argument chunk', () => {
    const long = `${'—'}${'x = 1; '.repeat(3_000)}`.slice(1)

    const copy = oneByteString(long)

    expect(copy).toBe(long)
    expect(isOneByteString(copy)).toBe(true)
  })

  it('hands the regex engine one-byte lines where Shiki alone would scan two-byte ones', async () => {
    const scan = (engine: ReturnType<typeof createJavaScriptRegexEngine>) => {
      const scanner = engine.createScanner(['answer'])
      return countWideGrammarScans(() => {
        scanner.findNextMatchSync(engine.createString(LINE), 0, 0)
      })
    }

    expect(await scan(createShikiJavaScriptRegexEngine())).toEqual({ scans: 1, wide: 1 })
    expect(await scan(createJavaScriptRegexEngine())).toEqual({ scans: 1, wide: 0 })
  })
})
