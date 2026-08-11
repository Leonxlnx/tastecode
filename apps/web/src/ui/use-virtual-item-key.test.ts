// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { Virtualizer, type VirtualizerOptions } from '@tanstack/react-virtual'
import type { Item } from '@harness/contracts'
import { describe, expect, it } from 'vitest'
import { useVirtualItemKey } from './use-virtual-item-key.js'

type KeyGetter = (index: number) => string | number

function message(id: string, text = id): Item {
  return {
    id,
    turnId: `turn-${id}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    text,
    createdAt: 0,
  }
}

function trackedItems(items: Item[]): {
  items: Item[]
  reads: () => number
} {
  let reads = 0
  return {
    items: new Proxy(items, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1
        return Reflect.get(target, property, receiver)
      },
    }),
    reads: () => reads,
  }
}

function options(
  count: number,
  getItemKey: KeyGetter,
): VirtualizerOptions<HTMLElement, HTMLElement> {
  return {
    count,
    getScrollElement: () => null,
    estimateSize: () => 72,
    scrollToFn: () => undefined,
    observeElementRect: () => undefined,
    observeElementOffset: () => undefined,
    getItemKey,
    initialRect: { width: 720, height: 800 },
  }
}

describe('virtualizer item keys', () => {
  it.each([100, 1_000, 10_000])('keeps streamed-render key reads bounded at %i items', (count) => {
    const initial = Array.from({ length: count }, (_, index) => message(`a-${index}`))
    const hook = renderHook(({ items, threadId }) => useVirtualItemKey(items, threadId), {
      initialProps: { items: initial, threadId: 'thread-a' },
    })
    const initialGetter = hook.result.current
    const virtualizer = new Virtualizer(options(count, initialGetter))
    virtualizer.getTotalSize()

    const streamed = trackedItems([
      ...initial.slice(0, -1),
      { ...initial.at(-1)!, text: 'streamed delta' },
    ])
    hook.rerender({
      items: streamed.items,
      threadId: 'thread-a',
    })

    virtualizer.setOptions(options(count, hook.result.current))
    virtualizer.getTotalSize()
    expect(streamed.reads()).toBeLessThanOrEqual(2)
    expect(hook.result.current).toBe(initialGetter)
  })

  it('keeps the key getter stable when a prompt is appended', () => {
    const first = [message('a-0'), message('a-1')]
    const hook = renderHook(({ items }) => useVirtualItemKey(items, 'thread-a'), {
      initialProps: { items: first },
    })
    const initialGetter = hook.result.current

    hook.rerender({ items: [...first, message('a-2')] })

    expect(hook.result.current).toBe(initialGetter)
    expect(hook.result.current(2)).toBe('a-2')
  })

  it('keeps a one-row streamed thread stable', () => {
    const hook = renderHook(({ items }) => useVirtualItemKey(items, 'thread-a'), {
      initialProps: { items: [message('a-0', 'Hel')] },
    })
    const initialGetter = hook.result.current

    hook.rerender({ items: [message('a-0', 'Hello')] })

    expect(hook.result.current).toBe(initialGetter)
  })

  it('invalidates an optimistic tail key when its canonical item arrives', () => {
    const first = [message('a-0'), message('a-1')]
    const hook = renderHook(({ items }) => useVirtualItemKey(items, 'thread-a'), {
      initialProps: { items: first },
    })
    const initialGetter = hook.result.current
    const virtualizer = new Virtualizer(options(first.length, initialGetter))
    virtualizer.getTotalSize()

    const optimistic = [...first, { ...message('local:prompt'), role: 'user' as const }]
    hook.rerender({ items: optimistic })
    expect(hook.result.current).toBe(initialGetter)
    virtualizer.setOptions(options(optimistic.length, hook.result.current))
    virtualizer.getTotalSize()
    expect(virtualizer.measurementsCache[2]?.key).toBe('local:prompt')

    const canonical = [...first, { ...optimistic.at(-1)!, id: 'canonical-prompt' }]
    hook.rerender({ items: canonical })

    expect(hook.result.current).not.toBe(initialGetter)
    virtualizer.setOptions(options(canonical.length, hook.result.current))
    virtualizer.getTotalSize()
    expect(virtualizer.measurementsCache[2]?.key).toBe('canonical-prompt')
  })

  it('invalidates same-length keys when the thread changes', () => {
    const first = [message('a-0'), message('a-1')]
    const second = [message('b-0'), message('b-1')]
    const hook = renderHook(({ items, threadId }) => useVirtualItemKey(items, threadId), {
      initialProps: { items: first, threadId: 'thread-a' },
    })
    const initialGetter = hook.result.current
    const virtualizer = new Virtualizer(options(first.length, initialGetter))
    virtualizer.getTotalSize()

    hook.rerender({ items: second, threadId: 'thread-b' })

    expect(hook.result.current).not.toBe(initialGetter)
    virtualizer.setOptions(options(second.length, hook.result.current))
    expect(virtualizer.getVirtualItemForOffset(0)?.key).toBe('b-0')
  })

  it('invalidates same-length keys when history is regenerated', () => {
    const first = [message('a-0'), message('a-1')]
    const reloaded = [message('history-0'), message('history-1')]
    const hook = renderHook(({ items, threadId }) => useVirtualItemKey(items, threadId), {
      initialProps: { items: first, threadId: 'thread-a' },
    })
    const initialGetter = hook.result.current
    const virtualizer = new Virtualizer(options(first.length, initialGetter))
    virtualizer.getTotalSize()

    hook.rerender({ items: reloaded, threadId: 'thread-a' })

    expect(hook.result.current).not.toBe(initialGetter)
    virtualizer.setOptions(options(reloaded.length, hook.result.current))
    expect(virtualizer.getVirtualItemForOffset(0)?.key).toBe('history-0')
  })
})
