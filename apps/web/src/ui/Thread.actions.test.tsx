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

function turnItem(id: string, createdAt: number, fields: Partial<Item>): Item {
  return {
    id,
    turnId: 'turn-1',
    type: 'message',
    status: 'completed',
    createdAt,
    ...fields,
  }
}

function renderCompleted(items: Item[]) {
  return render(
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
}

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

  it('preserves narration and activity in exact chronological groups', () => {
    const items: Item[] = [
      turnItem('prompt-1', 1, { role: 'user', text: 'Fix it' }),
      turnItem('update-1', 2, {
        role: 'assistant',
        phase: 'commentary',
        text: 'I found the cause.',
      }),
      turnItem('command-1', 3, { type: 'command', command: 'pnpm test', text: '12 passed' }),
      turnItem('update-2', 4, {
        role: 'assistant',
        phase: 'commentary',
        text: 'The focused test passes.',
      }),
      turnItem('files-1', 5, {
        type: 'file_change',
        path: 'src/chat.ts',
        text: '2 lines added',
      }),
      turnItem('answer-1', 6, {
        role: 'assistant',
        phase: 'final_answer',
        text: 'Fixed.',
      }),
    ]
    renderCompleted(items)

    const disclosures = screen.getAllByRole('button', { name: 'Worked for 1s' })
    expect(disclosures).toHaveLength(2)
    disclosures.forEach((disclosure) => fireEvent.click(disclosure))

    const firstNarration = screen.getByText('I found the cause.')
    const command = screen.getByText('pnpm test')
    const secondNarration = screen.getByText('The focused test passes.')
    const file = screen.getByText('Edited files')
    const answer = screen.getByText('Fixed.')
    expect(screen.getByText('12 passed')).toBeTruthy()
    expect(screen.getByText(/src\/chat\.ts\s+2 lines added/)).toBeTruthy()
    expect(
      firstNarration.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    expect(
      command.compareDocumentPosition(secondNarration) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    expect(
      secondNarration.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    expect(file.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('keeps every completed activity kind accessible after replay', () => {
    const items: Item[] = [
      turnItem('prompt-1', 1, { role: 'user', text: 'Build it' }),
      turnItem('reasoning-1', 2, { type: 'reasoning', text: 'Inspecting state' }),
      turnItem('command-1', 3, { type: 'command', command: 'pnpm test' }),
      turnItem('tool-1', 4, { type: 'tool_call', text: 'Searched 4 files' }),
      turnItem('design-1', 5, { type: 'tool_call', text: 'design:build' }),
      turnItem('answer-1', 6, {
        role: 'assistant',
        phase: 'final_answer',
        text: 'Built.',
      }),
    ]
    renderCompleted(items.map((entry) => ({ ...entry })))

    fireEvent.click(screen.getByRole('button', { name: 'Worked for 1s' }))
    expect(screen.getByText('Thinking')).toBeTruthy()
    expect(screen.getByText('Inspecting state')).toBeTruthy()
    expect(screen.getByText('pnpm test')).toBeTruthy()
    expect(screen.getByText('Searched 4 files')).toBeTruthy()
    expect(screen.getByText('Building the website')).toBeTruthy()
  })

  it('renders sequential image inspections clearly after replay', () => {
    const { container } = renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Review the layouts' }),
      turnItem('image-1', 2, { type: 'tool_call', text: 'image view\ndesktop.png' }),
      turnItem('image-2', 3, { type: 'tool_call', text: 'image view\nmobile.png' }),
      turnItem('image-3', 4, {
        type: 'tool_call',
        status: 'failed',
        text: 'image view\nbroken.png',
      }),
      turnItem('answer-1', 5, {
        role: 'assistant',
        phase: 'final_answer',
        text: 'Reviewed.',
      }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Worked for 1s' }))
    expect(screen.getAllByText('Viewed image')).toHaveLength(2)
    expect(screen.getByText('Could not view image')).toBeTruthy()
    expect(screen.getByText('desktop.png')).toBeTruthy()
    expect(screen.getByText('mobile.png')).toBeTruthy()
    expect(screen.getByText('broken.png')).toBeTruthy()
    expect(screen.queryByText('[imageView]')).toBeNull()
    expect(container.querySelectorAll('.lucide-images')).toHaveLength(3)
  })

  it('does not repeat identical file path and output details', () => {
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Fix it' }),
      turnItem('files-1', 2, {
        type: 'file_change',
        path: 'src/chat.ts',
        text: 'src/chat.ts',
      }),
      turnItem('answer-1', 3, { role: 'assistant', text: 'Fixed.' }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Worked for 1s' }))
    expect(screen.getAllByText('src/chat.ts')).toHaveLength(1)
  })

  it('shows response actions only on the explicit final answer', () => {
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Fix it' }),
      turnItem('update-1', 2, {
        role: 'assistant',
        phase: 'commentary',
        text: 'Checking.',
      }),
      turnItem('answer-1', 3, {
        role: 'assistant',
        phase: 'final_answer',
        text: 'Fixed.',
      }),
    ])

    expect(screen.getAllByRole('button', { name: 'Copy response' })).toHaveLength(1)
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

  it('shows visible accessible feedback when copying fails', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('Invalid clipboard text'))
    render(
      <Thread
        items={[
          {
            id: 'prompt-1',
            turnId: 'turn-1',
            type: 'message',
            role: 'user',
            status: 'completed',
            text: 'A prompt too large for the clipboard bridge',
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

    expect((await screen.findByRole('alert')).textContent).toBe('Copy failed')
    expect(screen.getByRole('button', { name: 'Copy prompt' }).getAttribute('title')).toBe(
      'Copy failed — click to retry',
    )
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
