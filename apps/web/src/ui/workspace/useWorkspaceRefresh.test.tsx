// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Item } from '@harness/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestTransport } from '../../test-transport.js'
import { LIVE_REFRESH_MS, useWorkspaceRefresh } from './useWorkspaceRefresh.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function item(type: Item['type'], id = 'item'): Item {
  return { id, turnId: 'turn', type, status: 'completed', createdAt: 1 }
}

function setup(initial: { visible: boolean; live?: boolean } = { visible: true }) {
  vi.useFakeTimers()
  const transport = new TestTransport()
  const refresh = vi.fn()
  let finishLive: (() => void) | undefined
  const live = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishLive = resolve
      }),
  )
  const hook = renderHook(
    (props: { visible: boolean }) =>
      useWorkspaceRefresh(transport, 'thread-1', refresh, {
        visible: props.visible,
        ...(initial.live === false ? {} : { onLiveChange: live }),
      }),
    { initialProps: { visible: initial.visible } },
  )
  const emit = (
    event: Parameters<typeof transport.emit<'thread.event'>>[1]['event'],
    id = 'thread-1',
  ) => act(() => transport.emit('thread.event', { threadId: id, event }))
  const edit = (id?: string) => emit({ type: 'item.completed', item: item('file_change') }, id)
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
  const settle = async () => {
    await act(async () => finishLive?.())
    finishLive = undefined
  }
  return { transport, refresh, live, hook, emit, edit, advance, settle }
}

describe('following a running turn', () => {
  it('reads a burst of edits at most once per interval and never per delta', async () => {
    const { live, emit, edit, advance, settle } = setup()
    for (let index = 0; index < 50; index += 1) {
      emit({ type: 'item.delta', turnId: 'turn', itemId: 'message', textDelta: 'x' })
    }
    emit({ type: 'item.completed', item: item('message') })
    emit({ type: 'item.completed', item: item('command') })
    await advance(LIVE_REFRESH_MS * 2)
    expect(live).not.toHaveBeenCalled()

    edit()
    edit()
    await advance(300)
    expect(live).toHaveBeenCalledTimes(1)
    await settle()

    for (let index = 0; index < 20; index += 1) {
      edit()
      emit({ type: 'diff.updated', turnId: 'turn', diff: '' })
      await advance(100)
    }
    // 2 s of edits after the first read: one more read, at its interval.
    expect(live).toHaveBeenCalledTimes(2)
    // An edit during that read gets one trailing read after it.
    edit()
    await settle()
    await advance(LIVE_REFRESH_MS)
    expect(live).toHaveBeenCalledTimes(3)
  })

  it('never starts a second read while one is running', async () => {
    const { live, edit, advance, settle } = setup()
    edit()
    await advance(300)
    expect(live).toHaveBeenCalledTimes(1)

    edit()
    await advance(LIVE_REFRESH_MS * 3)
    expect(live).toHaveBeenCalledTimes(1)
    await settle()
    await advance(LIVE_REFRESH_MS)
    expect(live).toHaveBeenCalledTimes(2)
  })

  it("ignores another chat's edits and lets the turn's end read everything", async () => {
    const { refresh, live, emit, edit, advance } = setup()
    edit('thread-2')
    await advance(LIVE_REFRESH_MS)
    expect(live).not.toHaveBeenCalled()

    edit()
    emit({ type: 'turn.completed', turnId: 'turn', status: 'completed' })
    await advance(LIVE_REFRESH_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(live).not.toHaveBeenCalled()
  })

  it('reads nothing while hidden and catches up once when shown', async () => {
    const { refresh, live, hook, emit, edit, advance } = setup({ visible: false })
    edit()
    emit({ type: 'turn.completed', turnId: 'turn', status: 'completed' })
    await advance(LIVE_REFRESH_MS * 2)
    expect(live).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()

    hook.rerender({ visible: true })
    await advance(200)
    expect(refresh).toHaveBeenCalledTimes(1)
    hook.rerender({ visible: false })
    hook.rerender({ visible: true })
    await advance(200)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps the turn-end refresh for a tool that does not follow edits', async () => {
    const { refresh, live, emit, edit, advance } = setup({ visible: true, live: false })
    edit()
    await advance(LIVE_REFRESH_MS)
    expect(live).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    emit({ type: 'turn.completed', turnId: 'turn', status: 'completed' })
    await advance(200)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
