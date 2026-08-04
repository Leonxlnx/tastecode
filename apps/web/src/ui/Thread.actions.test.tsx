// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Thread } from './Thread.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 72,
      })),
    getTotalSize: () => count * 72,
    measureElement: () => undefined,
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }),
}))

afterEach(cleanup)

describe('thread message actions', () => {
  it('copies the user prompt', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    render(
      <Thread
        items={[
          {
            id: 'prompt-1',
            turnId: 'turn-1',
            type: 'message',
            role: 'user',
            status: 'completed',
            text: 'Keep my exact prompt',
            createdAt: 1,
          },
        ]}
        running={false}
        activeTurn={undefined}
        plan={[]}
        diff={undefined}
        approvals={[]}
        userInputs={[]}
        reviews={[]}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Keep my exact prompt'))
  })

  it('sends a previous prompt back to the composer for editing', () => {
    const onEditMessage = vi.fn()
    render(
      <Thread
        items={[
          {
            id: 'prompt-1',
            turnId: 'turn-1',
            type: 'message',
            role: 'user',
            status: 'completed',
            text: 'Revise this prompt',
            createdAt: 1,
          },
        ]}
        running={false}
        activeTurn={undefined}
        plan={[]}
        diff={undefined}
        approvals={[]}
        userInputs={[]}
        reviews={[]}
        onEditMessage={onEditMessage}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit prompt' }))
    expect(onEditMessage).toHaveBeenCalledWith('Revise this prompt')
  })

  it('opens the checkpoint attached to that exact prompt', () => {
    const onRevertCheckpoint = vi.fn()
    const checkpoint = {
      id: 7,
      seq: 1,
      label: 'Undo this turn',
      createdAt: 50,
    }
    render(
      <Thread
        items={[
          {
            id: 'prompt-1',
            turnId: 'turn-1',
            type: 'message',
            role: 'user',
            status: 'completed',
            text: 'Undo this turn',
            createdAt: 100,
          },
        ]}
        running={false}
        activeTurn={undefined}
        plan={[]}
        diff={undefined}
        approvals={[]}
        userInputs={[]}
        reviews={[]}
        checkpoints={[checkpoint]}
        onRevertCheckpoint={onRevertCheckpoint}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Revert to before prompt' }))
    expect(onRevertCheckpoint).toHaveBeenCalledWith(checkpoint)
  })
})
