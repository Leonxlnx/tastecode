// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Item } from '@harness/contracts'
import { Thread, isRepeatedDesignRow, workLabel } from './Thread.js'

const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async () => undefined),
}))

vi.mock('../bridge.js', () => ({ writeClipboardText }))

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
    measurementsCache: [],
    getOffsetForIndex: () => [0],
    scrollToIndex: () => undefined,
  }),
}))

afterEach(cleanup)

describe('design activity rows', () => {
  const marker = (id: string, text: string): Item => ({
    id,
    turnId: `turn-${id}`,
    type: 'tool_call',
    status: 'completed',
    text,
    createdAt: 1,
  })

  it('renders the design phase label instead of the internal slug', () => {
    render(
      <Thread
        items={[marker('m1', 'design:brief')]}
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
    expect(screen.getByText('Preparing questions')).toBeTruthy()
    expect(screen.queryByText('design:brief')).toBeNull()
  })

  it('keeps a design turn to its phase story, without raw provider activity', () => {
    const items: Item[] = [
      { ...marker('m1', 'design:build'), status: 'started' },
      {
        id: 'cmd-1',
        turnId: 'turn-m1',
        type: 'command',
        status: 'completed',
        command: 'pwsh -Command Get-ChildItem',
        createdAt: 2,
      },
      { id: 'think-1', turnId: 'turn-m1', type: 'reasoning', status: 'completed', createdAt: 3 },
    ]
    render(
      <Thread
        items={items}
        running={true}
        activeTurn={{ id: 'turn-m1', startedAt: 1 }}
        plan={[]}
        diff={undefined}
        approvals={[]}
        userInputs={[]}
        reviews={[]}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    expect(screen.queryByText(/Get-ChildItem/)).toBeNull()
    expect(screen.queryByText('Thinking')).toBeNull()
    // The rail names the phase even while a tool runs inside the turn.
    expect(workLabel(items, 'turn-m1', false)).toBe('Building the website')
  })

  it('collapses phase markers repeated by retried provider turns', () => {
    const first = marker('m1', 'design:build')
    expect(isRepeatedDesignRow(marker('m2', 'design:build'), first)).toBe(true)
    expect(isRepeatedDesignRow(marker('m2', 'design:review'), first)).toBe(false)
    expect(isRepeatedDesignRow(marker('m2', 'some other tool'), first)).toBe(false)
    expect(isRepeatedDesignRow(first, undefined)).toBe(false)
  })
})

describe('completed activity disclosure', () => {
  it('keeps the content mounted while toggling the animated reveal state', () => {
    const items: Item[] = [
      {
        id: 'prompt-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'Fix it',
        createdAt: 1,
      },
      {
        id: 'update-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: 'I found the cause.',
        createdAt: 1_001,
      },
      {
        id: 'command-1',
        turnId: 'turn-1',
        type: 'command',
        status: 'completed',
        command: 'pnpm test',
        createdAt: 2_001,
      },
      {
        id: 'answer-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        text: 'Fixed.',
        createdAt: 3_001,
      },
    ]
    const { container } = render(
      <Thread
        items={items}
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

    const disclosure = screen.getByRole('button', { name: 'Worked for 3s' })
    const reveal = container.querySelector('.activity__reveal')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(reveal?.getAttribute('data-open')).toBe('false')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(disclosure)

    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(reveal?.getAttribute('data-open')).toBe('true')
    expect(reveal?.getAttribute('aria-hidden')).toBe('false')
  })
})

describe('collapsed row disclosure', () => {
  it('reveals a tool row through the animated disclosure', () => {
    const items: Item[] = [
      {
        id: 'prompt-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'user',
        status: 'completed',
        text: 'Fix it',
        createdAt: 1,
      },
      {
        id: 'command-1',
        turnId: 'turn-1',
        type: 'command',
        status: 'completed',
        command: 'pnpm test',
        text: '1 failed, 12 passed',
        createdAt: 2_001,
      },
    ]
    const { container } = render(
      <Thread
        items={items}
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

    const disclosure = screen.getByRole('button', { name: 'pnpm test' })
    const reveal = container.querySelector('.aux__reveal')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(reveal?.getAttribute('data-open')).toBe('false')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')
    expect(reveal?.hasAttribute('inert')).toBe(true)
    expect(container.querySelector('.aux__out')?.textContent).toBe('1 failed, 12 passed')

    fireEvent.click(disclosure)

    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(reveal?.getAttribute('data-open')).toBe('true')
    expect(reveal?.getAttribute('aria-hidden')).toBe('false')
    expect(reveal?.hasAttribute('inert')).toBe(false)
  })
})

describe('thread message actions', () => {
  it('copies the user prompt through the platform bridge', async () => {
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
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('Keep my exact prompt'))
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

  it('opens the truncated checkpoint attached to a long prompt', () => {
    const onRevertCheckpoint = vi.fn()
    const prompt = `  ${'Restore this long prompt exactly. '.repeat(3)}  `
    const checkpoint = {
      id: 8,
      seq: 2,
      label: prompt.trim().slice(0, 60),
      createdAt: 50,
    }
    render(
      <Thread
        items={[
          {
            id: 'prompt-2',
            turnId: 'turn-2',
            type: 'message',
            role: 'user',
            status: 'completed',
            text: prompt,
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
