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
})
