import { describe, expect, it } from 'vitest'
import type { Item } from '@harness/contracts'
import { enteringThreadItems } from './thread-entry.js'

function message(id: string, text = id): Item {
  return {
    id,
    turnId: 'turn',
    type: 'message',
    role: 'user',
    status: 'completed',
    text,
    createdAt: 0,
  }
}

describe('thread entry rows', () => {
  it('does not read or copy a bulk history load', () => {
    let reads = 0
    const history = new Proxy(
      Array.from({ length: 10_000 }, (_, index) => message(`${index}`)),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1
          return Reflect.get(target, property, receiver)
        },
      },
    )

    expect(enteringThreadItems([], history)).toEqual([])
    expect(reads).toBe(0)
  })

  it('returns only a normal live append', () => {
    const first = message('first')
    const second = message('second')
    expect(enteringThreadItems([first], [first, second])).toEqual([second])
  })

  it('does not animate an optimistic id reconciliation', () => {
    const local = message('local:1', 'hello')
    const durable = message('durable', 'hello')
    expect(enteringThreadItems([local], [durable])).toEqual([])
  })
})
