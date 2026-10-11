// @vitest-environment happy-dom
import type { Item } from '@harness/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread, reduceDeltas, type ThreadState } from '../thread-store.js'
import { ThreadSearch } from './ThreadSearch.js'

afterEach(cleanup)

const items: Item[] = Array.from({ length: 5 }, (_, index) => ({
  id: `item-${index}`,
  turnId: 'turn',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  text: 'Match',
  createdAt: index,
}))

describe('thread search navigation', () => {
  it('updates hits when the retained index appends or removes one item', () => {
    const props = { onJump: () => undefined, onClose: () => undefined }
    const view = render(<ThreadSearch {...props} items={items.slice(0, 1)} />)
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'match' } })
    expect(screen.getByText('1/1')).toBeTruthy()
    view.rerender(<ThreadSearch {...props} items={items.slice(0, 2)} />)
    expect(screen.getByText('1/2')).toBeTruthy()
    view.rerender(<ThreadSearch {...props} items={items.slice(0, 1)} />)
    expect(screen.getByText('1/1')).toBeTruthy()
  })

  it('leaves the Enter that confirms an IME conversion to the input method', () => {
    const onJump = vi.fn()
    render(<ThreadSearch items={items} onJump={onJump} onClose={() => undefined} />)
    const input = screen.getByLabelText('Find in thread')
    fireEvent.change(input, { target: { value: 'match' } })
    onJump.mockClear()
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(onJump).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onJump).toHaveBeenCalledWith(0)
  })

  it('searches only the streamed tail instead of rescanning the transcript per delta', () => {
    const settled = Array.from({ length: 300 }, (_, index) => ({
      ...items[0]!,
      id: `settled-${index}`,
      text: `Row ${index}`,
    }))
    const answer: Item = { ...items[0]!, id: 'answer', status: 'started', text: 'Partial nee' }
    let state: ThreadState = {
      ...emptyThread,
      items: [...settled, answer],
      running: true,
      activeTurn: { id: 'turn', startedAt: 0 },
    }
    const store = new ThreadFrameStore(state)
    render(
      <ThreadSearch
        frameStore={store}
        items={state.items}
        onJump={() => undefined}
        onClose={() => undefined}
      />,
    )
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'needle' } })
    expect(screen.getByText('None')).toBeTruthy()

    const includes = vi.spyOn(String.prototype, 'includes')
    for (const textDelta of ['dle', ' found', ' and more']) {
      state = reduceDeltas(state, [
        { type: 'item.delta', turnId: 'turn', itemId: 'answer', textDelta },
      ])
      act(() => store.publish(state))
    }
    const scans = includes.mock.calls.length
    includes.mockRestore()

    expect(screen.getByText('1/1')).toBeTruthy()
    expect(scans).toBeLessThan(settled.length)
  })

  it('clamps the counter and navigation when the transcript shrinks', () => {
    const onJump = vi.fn()
    const props = { threadId: 'thread', onJump, onClose: () => undefined }
    const view = render(<ThreadSearch {...props} items={items} />)
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'match' } })
    const next = screen.getByRole('button', { name: 'Next match' })
    for (let index = 0; index < 5; index += 1) fireEvent.click(next)
    expect(screen.getByText('5/5')).toBeTruthy()

    view.rerender(<ThreadSearch {...props} items={items.slice(0, 2)} />)
    expect(screen.getByText('2/2')).toBeTruthy()
    fireEvent.click(next)
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(onJump).toHaveBeenLastCalledWith(0)

    view.rerender(<ThreadSearch {...props} items={[]} />)
    expect(screen.getByText('None')).toBeTruthy()
    view.rerender(<ThreadSearch {...props} items={items} />)
    fireEvent.click(next)
    expect(screen.getByText('1/5')).toBeTruthy()
    expect(onJump).toHaveBeenLastCalledWith(0)
  })

  it('asks for unloaded turns once and keeps the shown match as they arrive above', () => {
    const onLoadOlder = vi.fn()
    const props = {
      threadId: 'thread',
      onJump: () => undefined,
      onClose: () => undefined,
      onLoadOlder,
    }
    const view = render(<ThreadSearch {...props} items={items.slice(2)} hasOlder />)
    expect(onLoadOlder).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'match' } })
    expect(onLoadOlder).toHaveBeenCalledOnce()
    view.rerender(<ThreadSearch {...props} items={items.slice(2)} hasOlder olderStatus="loading" />)
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'matc' } })
    expect(onLoadOlder).toHaveBeenCalledOnce()

    const next = screen.getByRole('button', { name: 'Next match' })
    fireEvent.click(next)
    fireEvent.click(next)
    expect(screen.getByText('2/3…')).toBeTruthy()

    // item-3 was on screen; two older matches now come before it.
    view.rerender(<ThreadSearch {...props} items={items} />)
    expect(screen.getByText('4/5')).toBeTruthy()
    expect(onLoadOlder).toHaveBeenCalledOnce()
  })

  it('says when older turns are still loading or failed, and retries only on request', () => {
    const onLoadOlder = vi.fn()
    const props = { onJump: () => undefined, onClose: () => undefined, onLoadOlder }
    const view = render(<ThreadSearch {...props} items={items} hasOlder olderStatus="loading" />)
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'absent' } })
    expect(screen.getByText('Searching…')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Searching earlier messages')

    view.rerender(<ThreadSearch {...props} items={items} hasOlder olderStatus="failed" />)
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Couldn’t search earlier messages')
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'absen' } })
    expect(onLoadOlder).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry searching earlier messages' }))
    expect(onLoadOlder).toHaveBeenCalledOnce()

    view.rerender(<ThreadSearch {...props} items={items} />)
    expect(screen.getByText('None')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry searching earlier messages' })).toBeNull()
  })
})
