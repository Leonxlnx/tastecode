// @vitest-environment happy-dom
import { bench, describe } from 'vitest'
import { composerResourceTriggerAt } from './Composer.js'

const OPTIONS = { time: 1_200, warmupTime: 300 }
const LONG_PREFIX = 'ordinary words '.repeat(74_898)
const LONG_TRIGGER = `${LONG_PREFIX}@performance`
const LONG_PLAIN_DRAFT = `${LONG_PREFIX}finished`
const LONG_UNBROKEN_DRAFT = 'x'.repeat(1024 * 1024)
const SHORT_TRIGGER = 'ask @performance'

function legacyResourceTriggerAt(
  text: string,
  cursor: number,
): ReturnType<typeof composerResourceTriggerAt> {
  const beforeCursor = text.slice(0, cursor)
  const match = /(^|[\s([{])([/$@])([\w.:-]*)$/.exec(beforeCursor)
  if (!match) return undefined
  const marker = match[2]
  if (marker !== '/' && marker !== '$' && marker !== '@') return undefined
  const query = match[3] ?? ''
  if (marker === '/' && /^(?:side|btw)$/i.test(query)) return undefined
  const start = cursor - query.length - 1
  let end = cursor
  while (end < text.length && /[\w.:-]/.test(text[end]!)) end += 1
  return { marker, query, start, end }
}

function assertTrigger(result: ReturnType<typeof composerResourceTriggerAt>): void {
  if (result?.marker !== '@' || result.query !== 'performance') {
    throw new Error('missing resource trigger')
  }
}

describe('resource trigger detection while typing', () => {
  bench(
    'scans and copies a one-megabyte draft',
    () => assertTrigger(legacyResourceTriggerAt(LONG_TRIGGER, LONG_TRIGGER.length)),
    OPTIONS,
  )

  bench(
    'checks only the active token in a one-megabyte draft',
    () => assertTrigger(composerResourceTriggerAt(LONG_TRIGGER, LONG_TRIGGER.length)),
    OPTIONS,
  )

  bench(
    'checks a one-megabyte plain draft without a trigger',
    () => {
      if (composerResourceTriggerAt(LONG_PLAIN_DRAFT, LONG_PLAIN_DRAFT.length) !== undefined) {
        throw new Error('unexpected resource trigger')
      }
    },
    OPTIONS,
  )

  bench(
    'checks a short trigger with the full-draft parser',
    () => assertTrigger(legacyResourceTriggerAt(SHORT_TRIGGER, SHORT_TRIGGER.length)),
    OPTIONS,
  )

  bench(
    'checks a short trigger',
    () => assertTrigger(composerResourceTriggerAt(SHORT_TRIGGER, SHORT_TRIGGER.length)),
    OPTIONS,
  )

  bench(
    'scans and copies a one-megabyte unbroken token',
    () => {
      if (legacyResourceTriggerAt(LONG_UNBROKEN_DRAFT, LONG_UNBROKEN_DRAFT.length) !== undefined) {
        throw new Error('unexpected resource trigger')
      }
    },
    OPTIONS,
  )

  bench(
    'falls back for a one-megabyte unbroken token',
    () => {
      if (
        composerResourceTriggerAt(LONG_UNBROKEN_DRAFT, LONG_UNBROKEN_DRAFT.length) !== undefined
      ) {
        throw new Error('unexpected resource trigger')
      }
    },
    OPTIONS,
  )
})
