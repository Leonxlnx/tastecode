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

  it('collapses a repeated phase across suppressed design activity', () => {
    renderCompleted([
      marker('m1', 'design:page'),
      {
        id: 'cmd-1',
        turnId: 'turn-m1',
        type: 'command',
        status: 'completed',
        command: 'pnpm build',
        createdAt: 2,
      },
      {
        id: 'think-1',
        turnId: 'turn-m1',
        type: 'reasoning',
        status: 'completed',
        text: 'Planning the implementation',
        createdAt: 3,
      },
      marker('m2', 'design:page'),
      marker('m3', 'design:build'),
      marker('m4', 'design:page'),
    ])

    expect(screen.getAllByText('Planning the page')).toHaveLength(2)
    expect(screen.getByText('Building the website')).toBeTruthy()
    expect(screen.queryByText('pnpm build')).toBeNull()
    expect(screen.queryByText('Planning the implementation')).toBeNull()
  })

  it('collapses phase markers repeated by retried provider turns', () => {
    const first = marker('m1', 'design:build')
    expect(isRepeatedDesignRow(marker('m2', 'design:build'), [first], 1)).toBe(true)
    expect(isRepeatedDesignRow(marker('m2', 'design:review'), [first], 1)).toBe(false)
    expect(isRepeatedDesignRow(marker('m2', 'some other tool'), [first], 1)).toBe(false)
    expect(isRepeatedDesignRow(first, [], 0)).toBe(false)
    expect(
      isRepeatedDesignRow(
        marker('m2', 'design:build'),
        [turnItem('note', 1, { text: 'design:build' })],
        1,
      ),
    ).toBe(false)
  })
})

describe('empty thread', () => {
  it('explains how to start an idle thread', () => {
    const rendered = renderCompleted([])

    expect(screen.getByRole('heading').textContent).toContain(
      'Tell the agent what you want to build',
    )

    rendered.rerender(
      <Thread
        items={[]}
        loading
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
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Loading conversation')
  })
})

describe('completed activity disclosure', () => {
  it('collapses a settled turn that ended without an assistant answer', () => {
    const items: Item[] = [
      turnItem('prompt-1', 1, { role: 'user', text: 'Build a website' }),
      ...Array.from({ length: 4 }, (_, index) =>
        turnItem(`reasoning-${index}`, 1_001 + index * 1_000, { type: 'reasoning' }),
      ),
    ]

    renderCompleted(items)

    expect(screen.getByRole('button', { name: 'Worked for 4s' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull()
  })

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

  it('does not claim an interrupted image inspection completed', () => {
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Review the layout' }),
      turnItem('image-1', 2, {
        type: 'tool_call',
        status: 'started',
        text: 'image view\ndesktop.png',
      }),
    ])

    expect(screen.getByRole('button', { name: 'Image inspection interrupted' })).toBeTruthy()
    expect(screen.queryByText('Viewed image')).toBeNull()
  })

  it('keeps image inspection status honest live and after replay', () => {
    const startedImage = turnItem('image-1', 2, {
      type: 'tool_call',
      status: 'started',
      text: 'image view\ndesktop.png',
    })
    const completedImage = { ...startedImage, status: 'completed' as const }
    const failedImage = { ...startedImage, status: 'failed' as const }
    const view = (image: Item) => (
      <Thread
        items={[image]}
        running
        activeTurn={{ id: 'turn-1', startedAt: 1 }}
        plan={[]}
        diff={undefined}
        approvals={[]}
        userInputs={[]}
        reviews={[]}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />
    )

    const rendered = render(view(startedImage))
    const rail = rendered.container.querySelector('.activity--working')
    expect(rendered.container.querySelector('.activity__working-label')?.textContent).toBe(
      'Viewing image',
    )
    expect(rendered.container.querySelector('[data-index="0"]')?.className).toContain(
      'is-suppressed',
    )
    expect(screen.queryByRole('button', { name: 'Viewing image' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Image inspection interrupted' })).toBeNull()
    expect(rendered.container.querySelectorAll('.aux--live')).toHaveLength(0)

    rendered.rerender(view(completedImage))
    expect(rendered.container.querySelector('.activity--working')).toBe(rail)
    expect(rendered.container.querySelector('[data-index="0"]')?.className).not.toContain(
      'is-suppressed',
    )
    expect(screen.getByRole('button', { name: 'Viewed image' })).toBeTruthy()
    expect(rendered.container.querySelector('.activity__working-label')?.textContent).toBe(
      'Working',
    )
    expect(rendered.container.querySelectorAll('.aux--live')).toHaveLength(0)

    rendered.rerender(view(failedImage))
    expect(rendered.container.querySelector('.activity--working')).toBe(rail)
    expect(screen.getByRole('button', { name: 'Could not view image' })).toBeTruthy()
    expect(rendered.container.querySelector('.activity__working-label')?.textContent).toBe(
      'Working',
    )
    expect(rendered.container.querySelectorAll('.aux--live')).toHaveLength(0)

    rendered.unmount()
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Review the layout' }),
      completedImage,
      turnItem('answer-1', 3, { role: 'assistant', text: 'Reviewed.' }),
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Worked for 1s' }))
    expect(screen.getByText('Viewed image')).toBeTruthy()
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

  it('hides response actions while a later turn is running', () => {
    render(
      <Thread
        items={[
          turnItem('prompt-1', 1, { role: 'user', text: 'Start designing' }),
          turnItem('answer-1', 2, {
            role: 'assistant',
            phase: 'final_answer',
            text: 'Got it, thanks.',
          }),
          turnItem('work-2', 3, {
            turnId: 'turn-2',
            type: 'tool_call',
            status: 'started',
            text: 'design:brief',
          }),
        ]}
        running
        activeTurn={{ id: 'turn-2', startedAt: 3 }}
        plan={[]}
        diff={undefined}
        approvals={[]}
        userInputs={[]}
        reviews={[]}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Copy response' })).toBeNull()
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

describe('thread error surface', () => {
  it('states the failure as text instead of a collapsible tool row', () => {
    const items: Item[] = [
      {
        id: 'error-1',
        turnId: 'turn-1',
        type: 'error',
        status: 'completed',
        text: 'Turn interrupted: Personal Harness restarted. Send a new message to continue.',
        createdAt: 1,
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

    // A thread-level failure is a statement: the alert and the reason, not an
    // operational row with a disclosure affordance.
    expect(container.querySelector('.turn-error__text')?.textContent).toBe(
      'Turn interrupted: Personal Harness restarted. Send a new message to continue.',
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('.aux')).toBeNull()
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
