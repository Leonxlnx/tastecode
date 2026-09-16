// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ApprovalRequest, Item } from '@harness/contracts'
import { StrictMode } from 'react'
import { ThreadFrameStore } from '../thread-frame-store.js'
import { emptyThread } from '../thread-store.js'
import {
  createRepeatedDesignRowProjector,
  Thread,
  isRepeatedDesignRow,
  workLabel,
} from './Thread.js'

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
      frameStore={new ThreadFrameStore({ ...emptyThread, items })}
      onDecide={() => undefined}
      onAnswerUserInput={() => undefined}
    />,
  )
}

describe('approval queue', () => {
  it('animates a new call in a reused stack, but not output updates or replay', () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }))
    const original = HTMLElement.prototype.animate
    HTMLElement.prototype.animate = animate as unknown as typeof original
    try {
      const first = turnItem('command-1', 2, { type: 'command', command: 'pwd' })
      const store = new ThreadFrameStore({
        ...emptyThread,
        items: [turnItem('prompt-1', 1, { role: 'user', text: 'Check files' }), first],
        running: true,
        activeTurn: { id: 'turn-1', startedAt: 1 },
      })
      render(
        <Thread
          frameStore={store}
          onDecide={() => undefined}
          onAnswerUserInput={() => undefined}
        />,
      )
      expect(animate).not.toHaveBeenCalled()
      const second = turnItem('command-2', 3, {
        type: 'command',
        command: 'ls',
        status: 'started',
      })
      act(() =>
        store.publish({ ...store.getSnapshot(), items: [...store.getSnapshot().items, second] }),
      )
      expect(animate).toHaveBeenCalledTimes(1)
      act(() =>
        store.publish({
          ...store.getSnapshot(),
          items: [...store.getSnapshot().items.slice(0, -1), { ...second, text: 'file.txt' }],
        }),
      )
      expect(animate).toHaveBeenCalledTimes(1)
    } finally {
      HTMLElement.prototype.animate = original
    }
  })

  it.each(['in_progress', 'approved', 'denied', 'timed_out', 'aborted'] as const)(
    'keeps automatic %s reviews out of chat while manual requests remain usable',
    (status) => {
      const onDecide = vi.fn()
      render(
        <Thread
          frameStore={
            new ThreadFrameStore({
              ...emptyThread,
              reviews: {
                'review-1': {
                  id: 'review-1',
                  turnId: 'turn-1',
                  status,
                  description: 'Automatic command review',
                  rationale: 'Automatic review rationale',
                  riskLevel: 'low',
                  startedAt: 10,
                },
              },
              approvals: [
                { id: 'approval-1', kind: 'command', command: 'pnpm test', createdAt: 10 },
              ],
            })
          }
          onDecide={onDecide}
          onAnswerUserInput={() => undefined}
        />,
      )

      expect(screen.queryByText('Automatic command review')).toBeNull()
      expect(screen.queryByText('Automatic review rationale')).toBeNull()
      expect(screen.queryByRole('status', { name: /Automatic review:/ })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
      expect(onDecide).toHaveBeenCalledWith('approval-1', 'approve')
    },
  )

  it('shows pending requests one at a time in request order', () => {
    const first: ApprovalRequest = {
      id: 'approval-1',
      kind: 'command',
      command: 'pnpm test',
      createdAt: 1,
    }
    const second: ApprovalRequest = {
      id: 'approval-2',
      kind: 'command',
      command: 'pnpm build',
      createdAt: 2,
    }
    const onDecide = vi.fn()
    const view = (approvals: ApprovalRequest[]) => (
      <Thread
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            running: true,
            activeTurn: { id: 'turn-1', startedAt: 0 },
            approvals,
          })
        }
        onDecide={onDecide}
        onAnswerUserInput={() => undefined}
      />
    )

    const rendered = render(view([first, second]))

    expect(screen.getByText('pnpm test')).toBeTruthy()
    expect(screen.queryByText('pnpm build')).toBeNull()
    expect(screen.getAllByText('Run this command?')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(onDecide).toHaveBeenCalledWith('approval-1', 'approve')

    rendered.rerender(view([second]))
    expect(screen.queryByText('pnpm test')).toBeNull()
    expect(screen.getByText('pnpm build')).toBeTruthy()
  })
})

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
        frameStore={new ThreadFrameStore({ ...emptyThread, items: [marker('m1', 'design:brief')] })}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    expect(screen.getByText('Understanding the request')).toBeTruthy()
    expect(screen.queryByText('design:brief')).toBeNull()
  })

  it('shows Design progress, provider commands, and errors alongside the phase label', () => {
    const items: Item[] = [
      { ...marker('m1', 'design:build'), status: 'started' },
      {
        id: 'progress-1',
        turnId: 'turn-m1',
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        status: 'completed',
        text: 'I am checking the existing styles before updating the page.',
        createdAt: 1,
      },
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
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items,
            running: true,
            activeTurn: { id: 'turn-m1', startedAt: 1 },
          })
        }
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    expect(
      screen.getByText('I am checking the existing styles before updating the page.'),
    ).toBeTruthy()
    expect(screen.getByText(/Get-ChildItem/)).toBeTruthy()
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.getByText('Exit code 1')).toBeTruthy()
    // The rail names the phase even while a tool runs inside the turn.
    expect(workLabel(items, 'turn-m1', false)).toBe('Building the website')
  })

  it('collapses a repeated phase while keeping provider activity visible', () => {
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
    expect(screen.getByText(/pnpm build/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Thought' }))
    expect(screen.getByText('Planning the implementation')).toBeTruthy()
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

  it('reuses repeated-design results while a transcript only streams text', () => {
    const first = marker('m1', 'design:build')
    const second = marker('m2', 'design:build')
    const lookup = createRepeatedDesignRowProjector()([first, second])

    expect(lookup(second, 1)).toBe(true)
    expect(lookup(second, 1)).toBe(true)
  })

  it('retains prefix results and invalidates a replaced tail row', () => {
    const first = marker('m1', 'design:build')
    const repeated = marker('m2', 'design:build')
    const project = createRepeatedDesignRowProjector()
    const initial = [first, repeated]

    expect(project(initial)(repeated, 1)).toBe(true)
    expect(project([...initial, turnItem('answer', 2, {})])(repeated, 1)).toBe(true)

    const changed = marker('m2', 'design:review')
    expect(project([first, changed])(changed, 1)).toBe(false)
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

  it('mounts standalone activity details only when opened', () => {
    const { container } = renderCompleted([
      turnItem('unknown', 1, {
        type: 'unknown',
        text: 'provider event detail',
      }),
    ])

    expect(container.querySelector('.aux__out')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Agent activity' }))
    expect(container.querySelector('.aux__out')?.textContent).toBe('provider event detail')
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
        frameStore={new ThreadFrameStore(emptyThread)}
        loading
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Loading conversation')
  })
})

describe('completed activity disclosure', () => {
  it('groups consecutive commands within commentary and keeps output behind two reveals', () => {
    const { container } = renderCompleted([
      turnItem('prompt', 1, { role: 'user', text: 'Check this' }),
      turnItem('intro', 2, { role: 'assistant', phase: 'commentary', text: 'Checking files.' }),
      ...Array.from({ length: 8 }, (_, index) =>
        turnItem(`cmd-${index}`, index + 3, {
          type: 'command',
          command: `check-${index}`,
          text: `output-${index}`,
        }),
      ),
      turnItem('update', 11, { role: 'assistant', phase: 'commentary', text: 'Now test.' }),
      turnItem('test-1', 12, { type: 'command', command: 'test-one' }),
      turnItem('test-2', 13, { type: 'command', command: 'test-two', exitCode: 1 }),
      turnItem('answer', 14, { role: 'assistant', phase: 'final_answer', text: 'Done.' }),
    ])
    fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
    expect(screen.getByText('Checking files.')).toBeTruthy()
    expect(screen.getByText('Now test.')).toBeTruthy()
    const commands = screen.getByRole('button', { name: 'Ran commands' })
    expect(screen.getByRole('button', { name: 'Ran commands (1 failed)' })).toBeTruthy()
    expect(container.querySelectorAll('.aux--command')).toHaveLength(0)
    fireEvent.click(commands)
    expect(container.querySelectorAll('.aux--command')).toHaveLength(8)
    expect(screen.queryByText('output-0')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ran check-0' }))
    expect(screen.getByText('output-0')).toBeTruthy()

    const reveal = commands.parentElement?.querySelector('.activity__reveal')
    fireEvent.click(commands)
    expect(reveal?.getAttribute('data-open')).toBe('closing')
    if (reveal) {
      fireEvent(
        reveal,
        Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'opacity' }),
      )
    }
    expect(reveal?.getAttribute('data-open')).toBe('closing')
    if (reveal) {
      fireEvent(
        reveal,
        Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'clip-path' }),
      )
    }
    expect(reveal?.getAttribute('data-open')).toBe('false')
    expect(container.querySelectorAll('.aux--command')).toHaveLength(0)
  })

  it('hides empty reasoning placeholders and keeps real thoughts behind a reveal', () => {
    const items: Item[] = [
      turnItem('prompt-1', 1, { role: 'user', text: 'Build a website' }),
      turnItem('reasoning-empty', 1_001, { type: 'reasoning' }),
      turnItem('reasoning-summary', 2_001, {
        type: 'reasoning',
        text: 'Planning manual multi-package checks',
        durationMs: 12_000,
      }),
    ]

    renderCompleted(items)

    expect(screen.queryByText('Thinking')).toBeNull()
    const thought = screen.getByRole('button', { name: 'Thought for 12s' })
    const reveal = thought.parentElement?.querySelector('.aux__reveal')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(thought)
    expect(reveal?.getAttribute('aria-hidden')).toBe('false')
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
        frameStore={new ThreadFrameStore({ ...emptyThread, items })}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    const disclosure = screen.getByRole('button', { name: 'Worked for 3s' })
    const reveal = container.querySelector('.activity__reveal')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(reveal?.getAttribute('data-open')).toBe('false')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.activity__body')).toBeNull()

    fireEvent.click(disclosure)

    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(reveal?.getAttribute('data-open')).toBe('true')
    expect(reveal?.getAttribute('aria-hidden')).toBe('false')
    expect(container.querySelector('.activity__body')).toBeTruthy()

    fireEvent.click(disclosure)

    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(reveal?.getAttribute('data-open')).toBe('closing')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.activity__body')).toBeTruthy()

    if (reveal) {
      fireEvent(
        reveal,
        Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'clip-path' }),
      )
    }

    expect(reveal?.getAttribute('data-open')).toBe('false')
    expect(container.querySelector('.activity__body')).toBeNull()
  })

  it('keeps a reopened command group open when its old close timer expires', () => {
    vi.useFakeTimers()
    try {
      renderCompleted([
        turnItem('prompt', 1, { role: 'user', text: 'Check it' }),
        turnItem('intro', 2, { role: 'assistant', phase: 'commentary', text: 'Checking.' }),
        turnItem('one', 3, { type: 'command', command: 'one' }),
        turnItem('two', 4, { type: 'command', command: 'two' }),
        turnItem('answer', 5, { role: 'assistant', phase: 'final_answer', text: 'Done.' }),
      ])
      fireEvent.click(screen.getByRole('button', { name: /Worked for/ }))
      const group = screen.getByRole('button', { name: 'Ran commands' })
      fireEvent.click(group)
      fireEvent.click(group)
      fireEvent.click(group)
      act(() => vi.advanceTimersByTime(200))
      expect(group.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByRole('button', { name: 'Ran one' })).toBeTruthy()
      fireEvent.click(group)
      act(() => vi.advanceTimersByTime(200))
      expect(screen.queryByRole('button', { name: 'Ran one' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
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

  it('folds interim narration into the completed work disclosure', () => {
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

    const disclosure = screen.getByRole('button', { name: 'Worked for 1s' })
    const reveal = disclosure.parentElement?.querySelector('.activity__reveal')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByText('I found the cause.')).toBeNull()
    expect(screen.queryByText('The focused test passes.')).toBeNull()
    expect(screen.getByText('Fixed.').closest('.activity__reveal')).toBeNull()
    fireEvent.click(disclosure)

    const firstNarration = screen.getByText('I found the cause.')
    const command = screen.getByText('Ran pnpm test')
    const secondNarration = screen.getByText('The focused test passes.')
    const file = screen.getByText('Edited src/chat.ts')
    const answer = screen.getByText('Fixed.')
    expect(reveal?.getAttribute('aria-hidden')).toBe('false')
    expect(firstNarration.closest('.activity__reveal')).toBe(reveal)
    expect(secondNarration.closest('.activity__reveal')).toBe(reveal)
    expect(screen.queryByText(/12 passed/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ran pnpm test' }))
    expect(screen.getByText(/12 passed/)).toBeTruthy()
    expect(screen.queryByText('2 lines added')).toBeNull()
    const fileDisclosure = screen.getByRole('button', { name: 'Edited src/chat.ts' })
    expect(fileDisclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(fileDisclosure)
    expect(fileDisclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('2 lines added')).toBeTruthy()
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

  it('folds persisted unphased Grok text bursts while keeping the last text visible', () => {
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Continue' }),
      turnItem('update-1', 1_001, {
        role: 'assistant',
        text: 'I will inspect the recent work.',
      }),
      turnItem('update-2', 2_001, {
        role: 'assistant',
        text: 'The focused tests pass.',
      }),
      turnItem('answer-1', 3_001, {
        role: 'assistant',
        text: 'Done.',
      }),
    ])

    const disclosure = screen.getByRole('button', { name: 'Worked for 3s' })
    const reveal = disclosure.parentElement?.querySelector('.activity__reveal')
    expect(reveal?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByText('I will inspect the recent work.')).toBeNull()
    expect(screen.queryByText('The focused tests pass.')).toBeNull()
    expect(screen.getByText('Done.').closest('.activity__reveal')).toBeNull()

    fireEvent.click(disclosure)

    expect(screen.getByText('I will inspect the recent work.').closest('.activity__reveal')).toBe(
      reveal,
    )
    expect(screen.getByText('The focused tests pass.').closest('.activity__reveal')).toBe(reveal)
    expect(screen.getByText('Done.').closest('.activity__reveal')).toBeNull()
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

    const thought = screen.getByRole('button', { name: 'Thought' })
    expect(thought.parentElement?.querySelector('.aux__reveal')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
    fireEvent.click(thought)
    expect(thought.parentElement?.querySelector('.aux__reveal')?.getAttribute('aria-hidden')).toBe(
      'false',
    )
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

    const thought = screen.getByRole('button', { name: 'Thought' })
    expect(thought).toBeTruthy()
    expect(thought.parentElement?.querySelector('.aux__reveal')?.getAttribute('aria-hidden')).toBe(
      'true',
    )
    expect(screen.queryByText('Planning manual multi-package checks')).toBeNull()
    expect(screen.queryByText('Ran git status --short')).toBeNull()

    fireEvent.click(thought)
    expect(screen.getByText('Planning manual multi-package checks')).toBeTruthy()
    const stack = screen.getByRole('button', { name: 'Read files, ran commands' })

    fireEvent.click(stack)

    fireEvent.click(screen.getByRole('button', { name: 'Ran commands' }))
    const firstCommand = screen.getByText('Ran git status --short')
    expect(firstCommand.closest('.activity__reveal')?.getAttribute('aria-hidden')).toBe('false')
    expect(screen.getByText('Ran pnpm test')).toBeTruthy()
  })

  it('shows a human tool headline instead of dumped JSON payloads', () => {
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Look it up' }),
      turnItem('grep-1', 2, {
        type: 'tool_call',
        text: 'grep [ { "type": "content", "content": { "type": "text", "text": "found 29 matches" } } ]\n{ "type": "GrepSearch", "stdout": [60, 119, 140] }',
      }),
      turnItem('read-1', 3, {
        type: 'tool_call',
        text: 'Searched thoughtLabel\nfound 12 matches',
      }),
      turnItem('grep-empty', 4, {
        type: 'tool_call',
        text: 'grep [ { "type": "content", "content": { "type": "text", "text": "" } } ]\n{ "type": "GrepSearch", "stdout": [60, 119] }',
      }),
      turnItem('answer-1', 5, { role: 'assistant', text: 'Done.' }),
    ])

    const stack = screen.getByRole('button', { name: 'Searched' })
    expect(stack.textContent).not.toMatch(/"type": "content"/)
    fireEvent.click(stack)
    expect(screen.queryByText(/"type": "content"/)).toBeNull()
    expect(screen.queryByText(/"type": "GrepSearch"/)).toBeNull()
    expect(screen.getByText('found 29 matches')).toBeTruthy()
    expect(screen.getByText('Searched thoughtLabel')).toBeTruthy()
    expect(screen.getByText('found 12 matches')).toBeTruthy()
  })

  it('hides empty structured output from persisted shell tool rows', () => {
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Check it' }),
      turnItem('command-1', 2, {
        type: 'command',
        command: 'git status --short',
        text: 'Bash [ { "type": "content", "content": { "type": "text", "text": "" } } ]\n{ "type": "Bash", "output": [], "exit_code": 0 }',
      }),
      turnItem('answer-1', 3, { role: 'assistant', text: 'Clean.' }),
    ])

    const stack = screen.getByRole('button', { name: 'Ran commands' })
    fireEvent.click(stack)
    expect(screen.queryByText(/"type": "content"/)).toBeNull()
    expect(screen.queryByText(/"type": "Bash"/)).toBeNull()
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
    expect(container.querySelectorAll('.activity__body .tabler-icon-library-photo')).toHaveLength(3)
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
          frameStore={
            new ThreadFrameStore({
              ...emptyThread,
              items: [
                turnItem('prompt-1', 1, {
                  role: 'user',
                  text: 'Strict preview',
                  attachments: [path],
                }),
              ],
            })
          }
          onDecide={() => undefined}
          onAnswerUserInput={() => undefined}
        />
      </StrictMode>,
    )

    expect(await screen.findByRole('img', { name: 'Preview of strict-reference.png' })).toBeTruthy()
    expect(previewViewedImage).toHaveBeenCalled()
  })

  it('finishes a missing sent image preview with an unavailable state', async () => {
    const path = '/tmp/TasteCode/pasted-files/missing-reference.png'
    previewViewedImage.mockResolvedValueOnce(undefined)

    renderCompleted([
      turnItem('prompt-1', 1, {
        role: 'user',
        text: 'Missing preview',
        attachments: [path],
      }),
    ])

    expect(
      await screen.findByRole('status', { name: 'Preview unavailable for missing-reference.png' }),
    ).toBeTruthy()
    expect(screen.getByText('missing-reference.png')).toBeTruthy()
  })

  it('finishes a rejected sent image preview after showing its loading state', async () => {
    const path = '/tmp/TasteCode/pasted-files/rejected-reference.png'
    let rejectPreview!: () => void
    previewViewedImage.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectPreview = () => reject(new Error('preview failed'))
      }),
    )

    renderCompleted([
      turnItem('prompt-1', 1, {
        role: 'user',
        text: 'Rejected preview',
        attachments: [path],
      }),
    ])

    expect(screen.getByRole('status', { name: 'Loading preview of rejected-reference.png' }))
    await act(async () => rejectPreview())
    expect(
      await screen.findByRole('status', { name: 'Preview unavailable for rejected-reference.png' }),
    ).toBeTruthy()
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
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items: [
              turnItem('prompt-1', 1, { role: 'user', text: 'Review it' }),
              turnItem('image-1', 2, {
                type: 'tool_call',
                text: 'image view\nuuid-layout.png',
              }),
              turnItem('answer-1', 3, { role: 'assistant', text: 'Reviewed.' }),
            ],
          })
        }
        projectPath="/work/site"
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
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items: [image],
            running: true,
            activeTurn: { id: 'turn-1', startedAt: 1 },
          })
        }
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

  it('keeps one copy action at the end of persisted Design history', () => {
    renderCompleted([
      turnItem('prompt-1', 1, { role: 'user', text: 'Design a site' }),
      turnItem('design-activity-1', 2, { type: 'tool_call', text: 'design:brief' }),
      turnItem('design-note-first', 3, {
        role: 'assistant',
        text: 'I have a few questions before designing.',
      }),
      turnItem('design-activity-2', 4, {
        turnId: 'turn-2',
        type: 'tool_call',
        text: 'design:brand',
      }),
      turnItem('design-note-second', 5, {
        turnId: 'turn-2',
        role: 'assistant',
        text: 'Brief locked in. Starting the design.',
      }),
      turnItem('design-complete-old', 6, {
        turnId: 'turn-3',
        role: 'assistant',
        text: 'Website built. Preview ready.',
      }),
    ])

    expect(screen.getAllByRole('button', { name: 'Copy response' })).toHaveLength(1)
    expect(
      screen
        .getByText('Website built. Preview ready.')
        .closest('.reply')
        ?.querySelector('[aria-label="Copy response"]'),
    ).toBeTruthy()
  })

  it('puts the turn revert beside the completed response', () => {
    const onRevertCheckpoint = vi.fn()
    const checkpoint = { id: 9, seq: 1, label: 'Fix it', createdAt: 0 }
    render(
      <Thread
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items: [
              turnItem('prompt-1', 1, { role: 'user', text: 'Fix it' }),
              turnItem('answer-1', 2, {
                role: 'assistant',
                phase: 'final_answer',
                text: 'Fixed.',
              }),
            ],
          })
        }
        checkpoints={[checkpoint]}
        onRevertCheckpoint={onRevertCheckpoint}
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Revert to before response' }))
    expect(onRevertCheckpoint).toHaveBeenCalledWith(checkpoint)
  })

  it('hides work when stopping and keeps checkpoints hidden until the turn ends', () => {
    const checkpoint = { id: 9, seq: 1, label: 'Fix it', createdAt: 0 }
    const store = new ThreadFrameStore({
      ...emptyThread,
      items: [
        turnItem('prompt-1', 1, { role: 'user', text: 'Fix it' }),
        turnItem('answer-1', 2, { role: 'assistant', text: 'Fixed.' }),
      ],
      running: true,
      activeTurn: { id: 'turn-2', startedAt: 3 },
    })
    const props = {
      frameStore: store,
      checkpoints: [checkpoint],
      onRevertCheckpoint: vi.fn(),
      onDecide: () => undefined,
      onAnswerUserInput: () => undefined,
    }
    const view = render(<Thread {...props} />)
    expect(view.container.querySelector('.activity--working')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Revert to before response' })).toBeNull()

    view.rerender(<Thread {...props} stopping />)

    expect(view.container.querySelector('.activity--working')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revert to before response' })).toBeNull()

    act(() => store.publish({ ...store.getSnapshot(), running: false, activeTurn: undefined }))

    fireEvent.click(screen.getByRole('button', { name: 'Revert to before response' }))
    expect(props.onRevertCheckpoint).toHaveBeenCalledWith(checkpoint)
  })

  it('keeps completed response actions visible while a later turn is running', () => {
    render(
      <Thread
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items: [
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
            ],
            running: true,
            activeTurn: { id: 'turn-2', startedAt: 3 },
          })
        }
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
        frameStore={new ThreadFrameStore({ ...emptyThread, items })}
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
    expect(container.querySelector('.activity__item-label')).toBeNull()
    expect(container.querySelector('.activity__detail')).toBeNull()

    fireEvent.click(disclosure)

    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(reveal?.getAttribute('data-open')).toBe('true')
    expect(reveal?.getAttribute('aria-hidden')).toBe('false')
    expect(reveal?.hasAttribute('inert')).toBe(false)
    const command = screen.getByRole('button', { name: 'Ran pnpm test' })
    expect(command.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('1 failed, 12 passed')).toBeNull()
    fireEvent.click(command)
    expect(command.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('1 failed, 12 passed')).toBeTruthy()
  })
})

describe('thread error surface', () => {
  it('keeps errors out of the transcript when the composer shows them', () => {
    const items: Item[] = [
      turnItem('error-1', 1, { type: 'error', text: 'Request failed' }),
      turnItem('answer-1', 2, { role: 'assistant', text: 'Existing reply' }),
    ]
    render(
      <Thread
        frameStore={new ThreadFrameStore({ ...emptyThread, items })}
        errorsInComposer
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )
    expect(screen.queryByText('Request failed')).toBeNull()
    expect(screen.getByText('Existing reply')).toBeTruthy()
  })

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
        frameStore={new ThreadFrameStore({ ...emptyThread, items })}
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
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items: [
              {
                id: 'prompt-1',
                turnId: 'turn-1',
                type: 'message',
                role: 'user',
                status: 'completed',
                text: 'Keep my exact prompt',
                createdAt: 1,
              },
            ],
          })
        }
        onDecide={() => undefined}
        onAnswerUserInput={() => undefined}
      />,
    )

    const copyButton = screen.getByRole('button', { name: 'Copy prompt' })
    const layers = copyButton.querySelectorAll('.icon-morph__layer')
    expect(layers).toHaveLength(3)
    expect(layers[0]?.hasAttribute('data-active')).toBe(true)

    fireEvent.click(copyButton)
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith('Keep my exact prompt'))
    await waitFor(() => expect(layers[1]?.hasAttribute('data-active')).toBe(true))
  })

  it('shows visible accessible feedback when copying fails', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('Invalid clipboard text'))
    render(
      <Thread
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items: [
              {
                id: 'prompt-1',
                turnId: 'turn-1',
                type: 'message',
                role: 'user',
                status: 'completed',
                text: 'A prompt too large for the clipboard bridge',
                createdAt: 1,
              },
            ],
          })
        }
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
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items: [
              {
                id: 'prompt-1',
                turnId: 'turn-1',
                type: 'message',
                role: 'user',
                status: 'completed',
                text: 'Revise this prompt',
                createdAt: 1,
              },
            ],
          })
        }
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
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items: [
              {
                id: 'prompt-1',
                turnId: 'turn-1',
                type: 'message',
                role: 'user',
                status: 'completed',
                text: 'Undo this turn',
                createdAt: 100,
              },
            ],
          })
        }
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
        frameStore={
          new ThreadFrameStore({
            ...emptyThread,
            items: [
              {
                id: 'prompt-2',
                turnId: 'turn-2',
                type: 'message',
                role: 'user',
                status: 'completed',
                text: prompt,
                createdAt: 100,
              },
            ],
          })
        }
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
