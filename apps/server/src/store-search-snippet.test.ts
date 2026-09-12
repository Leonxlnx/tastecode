import { describe, expect, it } from 'vitest'
import type { SessionSearchResult } from '@harness/contracts'
import { createSearchSnippet } from './store.js'

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_]*/gu

function legacySnippet(value: string, terms: readonly string[]): SessionSearchResult['snippet'] {
  const comparableTerms = terms.map(comparableToken)
  const tokens = [...value.matchAll(TOKEN)].map((match) => {
    const start = match.index
    const text = match[0]
    return {
      start,
      end: start + text.length,
      highlighted: comparableTerms.some((term) => comparableToken(text).startsWith(term)),
    }
  })
  if (tokens.length === 0) return [{ text: value, highlighted: false }]

  const firstMatch = tokens.findIndex((token) => token.highlighted)
  const tokenLimit = 24
  const firstToken =
    tokens.length <= tokenLimit || firstMatch < 0
      ? 0
      : Math.max(0, Math.min(firstMatch - 6, tokens.length - tokenLimit))
  const lastToken = Math.min(tokens.length, firstToken + tokenLimit)
  const start = firstToken === 0 ? 0 : tokens[firstToken]!.start
  const end = lastToken === tokens.length ? value.length : tokens[lastToken - 1]!.end
  const parts: SessionSearchResult['snippet'] = []
  const append = (text: string, highlighted: boolean) => {
    if (!text) return
    const previous = parts.at(-1)
    if (previous?.highlighted === highlighted) previous.text += text
    else parts.push({ text, highlighted })
  }

  if (start > 0) append('… ', false)
  let cursor = start
  for (let index = firstToken; index < lastToken; index += 1) {
    const token = tokens[index]!
    append(value.slice(cursor, token.start), false)
    append(value.slice(token.start, token.end), token.highlighted)
    cursor = token.end
  }
  append(value.slice(cursor, end), false)
  if (end < value.length) append(' …', false)
  return parts.length > 0 ? parts : [{ text: value, highlighted: false }]
}

function comparableToken(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '')
}

describe('bounded search snippets', () => {
  it('preserves the prior window and highlighting for short, early, middle, late, and missing matches', () => {
    const words = Array.from({ length: 40 }, (_, index) => `token${index}`)
    const cases = [
      { value: '', terms: ['performance'] },
      { value: '... -- ...', terms: ['performance'] },
      { value: 'A short Résumé.', terms: ['resume'] },
      { value: ['Performance', ...words].join(' '), terms: ['performance'] },
      {
        value: [...words.slice(0, 20), 'performance', ...words.slice(20)].join(' '),
        terms: ['performance'],
      },
      { value: [...words, 'performance'].join(' '), terms: ['performance'] },
      { value: words.join(' '), terms: ['missing'] },
    ]

    for (const example of cases) {
      expect(createSearchSnippet(example.value, example.terms)).toEqual(
        legacySnippet(example.value, example.terms),
      )
    }
  })

  it('matches the prior algorithm across every position around the 24-token window', () => {
    for (let tokenCount = 1; tokenCount <= 64; tokenCount += 1) {
      for (let matchIndex = -1; matchIndex < tokenCount; matchIndex += 1) {
        const value = Array.from({ length: tokenCount }, (_, index) =>
          index === matchIndex ? 'performance' : `token${index}`,
        ).join(' ')
        expect(createSearchSnippet(value, ['performance'])).toEqual(
          legacySnippet(value, ['performance']),
        )
      }
    }
  })

  it('matches the prior algorithm for late ASCII hits, token edges, and missing hits', () => {
    const filler = Array.from({ length: 1_200 }, (_, index) => `token_${index}`).join(' ')
    const cases = [
      { value: `${filler} performance`, terms: ['performance'] },
      { value: `${filler} performance one two three`, terms: ['performance'] },
      {
        value: `${filler} notperformance token__performance __performance one two`,
        terms: ['performance'],
      },
      { value: `${filler} still missing`, terms: ['performance'] },
      { value: `Résumé ${filler} performance`, terms: ['resume', 'performance'] },
    ]

    for (const example of cases) {
      expect(createSearchSnippet(example.value, example.terms)).toEqual(
        legacySnippet(example.value, example.terms),
      )
    }
  })
})
