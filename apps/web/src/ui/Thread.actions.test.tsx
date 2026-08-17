// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Item } from '@harness/contracts'
import { StrictMode } from 'react'
import { Thread, isRepeatedDesignRow, workLabel } from './Thread.js'

const { previewViewedImage, revealPath, writeClipboardText } = vi.hoisted(() => ({
  previewViewedImage: vi.fn(async (): Promise<unknown> => undefined),
  revealPath: vi.fn(async () => undefined),
  writeClipboardText: vi.fn(async () => undefined),
}))

vi.mock('../bridge.js', () => ({ previewViewedImage, revealPath, writeClipboardText }))

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

afterEach(() => {
  cleanup()
  previewViewedImage.mockReset()
  previewViewedImage.mockResolvedValue(undefined)
  revealPath.mockReset()
})

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
      {
        id: 'error-1',
        turnId: 'turn-m1',
        type: 'error',
        status: 'completed',
        text: 'Exit code 1',
        createdAt: 4,
      },
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
    expect(screen.queryByText('Exit code 1')).toBeNull()
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

describe('provider activity labels', () => {
  it('uses a completed label for saved context-compaction rows', () => {
    renderCompleted([
      turnItem('compact', 1, {
        type: 'unknown',
        text: '[contextCompaction]',
      }),
    ])

    expect(screen.getByText('Compacted context window')).toBeTruthy()
    expect(screen.queryByText('unknown')).toBeNull()
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
  it('hides empty reasoning placeholders and keeps real summaries readable', () => {
    const items: Item[] = [
      turnItem('prompt-1', 1, { role: 'user', text: 'Build a website' }),
      turnItem('reasoning-empty', 1_001, { type: 'reasoning' }),
      turnItem('reasoning-summary', 2_001, {
        type: 'reasoning',
        text: 'Planning manual multi-package checks',
      }),
    ]

    renderCompleted(items)

    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.getByText('Planning manual multi-package checks')).toBeTruthy()
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

    const disclosure = screen.getByRole('button', { name: 'Ran commands' })
    const reveal = container.querySelector('.activity__reveal')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(reveal?.getAttribute('data-open')).toBe('false')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')

    fireEvent.click(disclosure)

    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(reveal?.getAttribute('data-open')).toBe('true')
    expect(reveal?.getAttribute('aria-hidden')).toBe('false')

    fireEvent.click(disclosure)

    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(reveal?.getAttribute('data-open')).toBe('closing')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')

    if (reveal) fireEvent.animationEnd(reveal)

    expect(reveal?.getAttribute('data-open')).toBe('false')
  })

  it('closes immediately when reduced motion is enabled', () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
        }) as MediaQueryList,
    )
    const { container } = renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Fix it' }),
      turnItem('command-1', 2, { type: 'command', command: 'pnpm test' }),
      turnItem('answer-1', 3, {
        role: 'assistant',
        phase: 'final_answer',
        text: 'Fixed.',
      }),
    ])
    const disclosure = screen.getByRole('button', { name: 'Ran commands' })
    const reveal = container.querySelector('.activity__reveal')

    fireEvent.click(disclosure)
    fireEvent.click(disclosure)

    expect(reveal?.getAttribute('data-open')).toBe('false')
    matchMedia.mockRestore()
  })

  it('keeps narration visible while work uses one disclosure', () => {
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

    const disclosure = screen.getByRole('button', { name: 'Ran commands, edited files' })
    expect(screen.getAllByRole('button', { name: /Ran commands|Edited files/ })).toHaveLength(1)
    fireEvent.click(disclosure)

    const firstNarration = screen.getByText('I found the cause.')
    const command = screen.getByText('Ran pnpm test')
    const secondNarration = screen.getByText('The focused test passes.')
    const file = screen.getByText('Edited src/chat.ts')
    const answer = screen.getByText('Fixed.')
    expect(screen.getByText(/12 passed/)).toBeTruthy()
    expect(screen.getByText('2 lines added')).toBeTruthy()
    expect(
      firstNarration.compareDocumentPosition(command) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    expect(command.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(
      file.compareDocumentPosition(secondNarration) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    expect(
      secondNarration.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
  })

  it('keeps every completed activity kind accessible after replay', () => {
    const items: Item[] = [
      turnItem('prompt-1', 1, { role: 'user', text: 'Build it' }),
      turnItem('reasoning-1', 2, { type: 'reasoning', text: 'Inspecting state' }),
      turnItem('command-1', 3, { type: 'command', command: 'pnpm test' }),
      turnItem('tool-1', 4, { type: 'tool_call', text: 'Searched 4 files' }),
      turnItem('answer-1', 6, {
        role: 'assistant',
        phase: 'final_answer',
        text: 'Built.',
      }),
    ]
    renderCompleted(items.map((entry) => ({ ...entry })))

    expect(screen.getByText('Inspecting state')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ran commands, searched' }))
    expect(screen.getByText('Ran pnpm test')).toBeTruthy()
    expect(screen.getByText('Searched 4 files')).toBeTruthy()
  })

  it('stacks tool categories and keeps each command available on expand', () => {
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Check it' }),
      turnItem('reasoning-1', 2, {
        type: 'reasoning',
        text: 'Planning manual multi-package checks',
      }),
      turnItem('read-1', 3, { type: 'tool_call', text: 'read files' }),
      turnItem('command-1', 4, { type: 'command', command: 'git status --short' }),
      turnItem('command-2', 5, { type: 'command', command: 'pnpm test' }),
      turnItem('answer-1', 6, { role: 'assistant', text: 'Done.' }),
    ])

    expect(screen.getByText('Planning manual multi-package checks')).toBeTruthy()
    const firstCommand = screen.getByText('Ran git status --short')
    expect(firstCommand.closest('.activity__reveal')?.getAttribute('aria-hidden')).toBe('true')
    const stack = screen.getByRole('button', { name: 'Read files, ran commands' })

    fireEvent.click(stack)

    expect(firstCommand.closest('.activity__reveal')?.getAttribute('aria-hidden')).toBe('false')
    expect(screen.getByText('Ran pnpm test')).toBeTruthy()
  })

  it('stacks all tool calls across empty reasoning placeholders', () => {
    const { container } = renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Check it' }),
      turnItem('reasoning-1', 2, { type: 'reasoning' }),
      turnItem('files-1', 3, {
        type: 'file_change',
        path: 'src/chat.ts',
        text: '2 files changed',
      }),
      turnItem('reasoning-2', 4, { type: 'reasoning', text: '  ' }),
      turnItem('command-1', 5, { type: 'command', command: 'git status --short' }),
      turnItem('reasoning-3', 6, { type: 'reasoning' }),
      turnItem('read-1', 7, { type: 'tool_call', text: 'read files' }),
      turnItem('answer-1', 8, { role: 'assistant', text: 'Done.' }),
    ])

    expect(container.querySelectorAll('.activity')).toHaveLength(1)
    expect(screen.queryByText('Thinking')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Edited files, ran commands, read files' }))

    expect(screen.getByText('Edited src/chat.ts')).toBeTruthy()
    expect(screen.getByText('Ran git status --short')).toBeTruthy()
    expect(screen.getByText('read files')).toBeTruthy()
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

    fireEvent.click(screen.getByRole('button', { name: 'Viewed images' }))
    expect(screen.getAllByText('Viewed image')).toHaveLength(2)
    expect(screen.getByText('Could not view image')).toBeTruthy()
    expect(screen.getByText('desktop.png')).toBeTruthy()
    expect(screen.getByText('mobile.png')).toBeTruthy()
    expect(screen.getByText('broken.png')).toBeTruthy()
    expect(screen.queryByText('[imageView]')).toBeNull()
    expect(container.querySelectorAll('.activity__body .lucide-images')).toHaveLength(3)
  })

  it('shows sent image attachments above the user message', async () => {
    const path = '/tmp/TasteCode/pasted-files/uuid-reference.png'
    previewViewedImage.mockResolvedValueOnce({
      path,
      name: 'uuid-reference.png',
      mediaType: 'image',
      previewUrl: 'tastecode-attachment://preview/full',
      thumbnailUrl: 'tastecode-attachment://preview/thumb?thumbnail=1',
    })
    const { container } = renderCompleted([
      turnItem('prompt-1', 1, {
        role: 'user',
        text: 'Use this reference',
        attachments: [path, '/work/notes.txt'],
      }),
    ])

    const image = await screen.findByRole('img', { name: 'Preview of uuid-reference.png' })
    const attachments = container.querySelector('.said__attachments')
    const text = screen.getByText('Use this reference')
    if (!attachments) throw new Error('sent attachment preview was not rendered')
    expect(previewViewedImage).toHaveBeenCalledWith(path)
    expect(attachments.contains(image)).toBe(true)
    expect(
      attachments.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(container.querySelectorAll('.viewed-image-preview--message')).toHaveLength(1)
  })

  it('finishes a sent image preview after the Strict Mode effect replay', async () => {
    const path = '/tmp/TasteCode/pasted-files/strict-reference.png'
    previewViewedImage.mockResolvedValue({
      path,
      name: 'strict-reference.png',
      mediaType: 'image',
      previewUrl: 'tastecode-attachment://preview/strict',
    })

    render(
      <StrictMode>
        <Thread
          items={[
            turnItem('prompt-1', 1, {
              role: 'user',
              text: 'Strict preview',
              attachments: [path],
            }),
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
        />
      </StrictMode>,
    )

    expect(await screen.findByRole('img', { name: 'Preview of strict-reference.png' })).toBeTruthy()
    expect(previewViewedImage).toHaveBeenCalled()
  })

  it('shows a safe image preview when completed work is revealed', async () => {
    previewViewedImage.mockResolvedValueOnce({
      path: '/tmp/TasteCode/pasted-files/uuid-layout.png',
      name: 'uuid-layout.png',
      mediaType: 'image',
      previewUrl: 'tastecode-attachment://preview/full',
      thumbnailUrl: 'tastecode-attachment://preview/thumb?thumbnail=1',
    })
    render(
      <Thread
        items={[
          turnItem('prompt-1', 1, { role: 'user', text: 'Review it' }),
          turnItem('image-1', 2, {
            type: 'tool_call',
            text: 'image view\nuuid-layout.png',
          }),
          turnItem('answer-1', 3, { role: 'assistant', text: 'Reviewed.' }),
        ]}
        projectPath="/work/site"
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

    fireEvent.click(screen.getByRole('button', { name: 'Viewed images' }))

    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Preview of uuid-layout.png' })).toBeTruthy(),
    )
    expect(previewViewedImage).toHaveBeenCalledWith('uuid-layout.png')
    expect(screen.getByRole('button', { name: 'Open preview of uuid-layout.png' })).toBeTruthy()
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
    const stack = rendered.container.querySelector('.activity')
    expect(screen.getByRole('button', { name: 'Viewing image' })).toBeTruthy()
    expect(rendered.container.querySelector('[data-index="0"]')?.className).not.toContain(
      'is-suppressed',
    )
    expect(screen.queryByRole('button', { name: 'Image inspection interrupted' })).toBeNull()
    expect(rendered.container.querySelectorAll('.aux--live')).toHaveLength(0)

    rendered.rerender(view(completedImage))
    expect(rendered.container.querySelector('.activity')).toBe(stack)
    expect(rendered.container.querySelector('[data-index="0"]')?.className).not.toContain(
      'is-suppressed',
    )
    expect(screen.getByRole('button', { name: 'Viewed image' })).toBeTruthy()
    expect(rendered.container.querySelectorAll('.aux--live')).toHaveLength(0)

    rendered.rerender(view(failedImage))
    expect(rendered.container.querySelector('.activity')).toBe(stack)
    expect(screen.getByRole('button', { name: 'Could not view image' })).toBeTruthy()
    expect(rendered.container.querySelectorAll('.aux--live')).toHaveLength(0)

    rendered.unmount()
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Review the layout' }),
      completedImage,
      turnItem('answer-1', 3, { role: 'assistant', text: 'Reviewed.' }),
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Viewed images' }))
    expect(screen.getByText('Viewed image')).toBeTruthy()
  })

  it('names context compaction while running and after replay', () => {
    const startedCompaction = turnItem('compaction-1', 2, {
      type: 'tool_call',
      status: 'started',
      text: 'context compaction',
    })

    expect(workLabel([startedCompaction], 'turn-1', false)).toBe('Compacting context window…')

    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Continue' }),
      { ...startedCompaction, status: 'completed' },
      turnItem('answer-1', 3, { role: 'assistant', text: 'Done.' }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Compacted context window' }))
    expect(screen.getAllByText('Compacted context window')).toHaveLength(2)
    expect(screen.queryByText('context compaction')).toBeNull()
    expect(screen.queryByText('[contextCompaction]')).toBeNull()
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

    fireEvent.click(screen.getByRole('button', { name: 'Edited files' }))
    expect(screen.getByText('Edited src/chat.ts')).toBeTruthy()
    expect(document.querySelector('.activity__detail')).toBeNull()
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

  it('puts the turn revert beside the completed response', () => {
    const onRevertCheckpoint = vi.fn()
    const checkpoint = { id: 9, seq: 1, label: 'Fix it', createdAt: 0 }
    render(
      <Thread
        items={[
          turnItem('prompt-1', 1, { role: 'user', text: 'Fix it' }),
          turnItem('answer-1', 2, {
            role: 'assistant',
            phase: 'final_answer',
            text: 'Fixed.',
          }),
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

    fireEvent.click(screen.getByRole('button', { name: 'Revert to before response' }))
    expect(onRevertCheckpoint).toHaveBeenCalledWith(checkpoint)
  })

  it('keeps completed response actions visible while a later turn is running', () => {
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

    expect(screen.getByRole('button', { name: 'Copy response' })).toBeTruthy()
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

    const disclosure = screen.getByRole('button', { name: 'Ran commands' })
    const reveal = container.querySelector('.activity__reveal')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(reveal?.getAttribute('data-open')).toBe('false')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')
    expect(reveal?.hasAttribute('inert')).toBe(true)
    expect(container.querySelector('.activity__item-label')?.textContent).toBe('Ran pnpm test')
    expect(container.querySelector('.activity__detail')?.textContent).toBe('1 failed, 12 passed')

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
        text: 'Turn interrupted: TasteCode restarted. Send a new message to continue.',
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
      'Turn interrupted: TasteCode restarted. Send a new message to continue.',
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
