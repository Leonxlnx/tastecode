// @vitest-environment happy-dom
import type { Item } from '@harness/contracts'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    const onSearchOlder = vi.fn()
    const props = {
      threadId: 'thread',
      onJump: () => undefined,
      onClose: () => undefined,
      onSearchOlder,
    }
    const view = render(<ThreadSearch {...props} items={items.slice(2)} hasOlder />)
    expect(onSearchOlder).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'match' } })
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'matc' } })
    expect(onSearchOlder).toHaveBeenCalledOnce()

    const next = screen.getByRole('button', { name: 'Next match' })
    fireEvent.click(next)
    fireEvent.click(next)
    view.rerender(<ThreadSearch {...props} items={items.slice(2)} hasOlder searchingOlder />)
    expect(screen.getByText('2/3…')).toBeTruthy()

    // item-3 was on screen; two older matches now come before it.
    view.rerender(<ThreadSearch {...props} items={items} />)
    expect(screen.getByText('4/5')).toBeTruthy()
  })

  it('says it is still searching while older turns load without a match yet', () => {
    const props = { onJump: () => undefined, onClose: () => undefined }
    const view = render(<ThreadSearch {...props} items={items} hasOlder searchingOlder />)
    fireEvent.change(screen.getByLabelText('Find in thread'), { target: { value: 'absent' } })
    expect(screen.getByText('Searching…')).toBeTruthy()
    view.rerender(<ThreadSearch {...props} items={items} />)
    expect(screen.getByText('None')).toBeTruthy()
  })
})
