// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DomainEvent, UserInputRequest } from '@harness/contracts'
import { NeedsYouAsks } from '../needs-you-asks.js'
import { emptyThread, type ThreadState } from '../thread-state.js'
import { reduceEventLog } from '../thread-store.js'
import { Sidebar, type Session } from './Sidebar.js'
import type { NeedsYouPeekActions } from './SidebarPeek.js'

let clock = 1_000
beforeEach(() => {
  clock = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const page = (...events: DomainEvent[]) => events.map((event, index) => ({ seq: index + 1, event }))
const state = (...events: DomainEvent[]): ThreadState =>
  reduceEventLog(emptyThread, page(...events))
const started: DomainEvent = {
  type: 'turn.started',
  turn: { id: 'turn-1', threadId: 'x', status: 'running', createdAt: 1 },
}
const approval: DomainEvent = {
  type: 'approval.requested',
  request: {
    id: 'approval-1',
    kind: 'command',
    command: 'pnpm add zod@4.1.2',
    cwd: 'E:\\work\\billing-service',
    reason: 'Install the validation library',
    createdAt: 2,
  },
}
const question = (overrides: Partial<UserInputRequest['questions'][number]> = {}): DomainEvent => ({
  type: 'user_input.requested',
  request: {
    id: 'input-1',
    turnId: 'turn-1',
    questions: [
      {
        id: 'rounding',
        header: 'Rounding',
        question: 'Which currency rounding do we keep?',
        allowOther: true,
        secret: false,
        options: [
          { label: "Banker's rounding", description: 'Round halves to even' },
          { label: 'Half-up', description: 'Round halves away from zero' },
        ],
        ...overrides,
      },
    ],
    autoResolutionMs: null,
    createdAt: 3,
  },
})

const chat = (
  id: string,
  title: string,
  status: Session['status'],
  extra: Partial<Session> = {},
) => ({
  id,
  title,
  provider: 'codex' as const,
  createdAt: 1,
  statusSince: 1,
  status,
  lifecycle: { state: 'active' as const, keepActive: false },
  unread: status === 'failed',
  ...extra,
})

function setup(
  options: { questionOverrides?: Partial<UserInputRequest['questions'][number]> } = {},
) {
  const pages = new Map<string, DomainEvent[]>([
    ['approval-chat', [started, approval]],
    ['question-chat', [started, question(options.questionOverrides)]],
  ])
  const live = new Map<string, ThreadState>([
    ['approval-chat', state(started, approval)],
    ['question-chat', state(started, question(options.questionOverrides))],
  ])
  const asks = new NeedsYouAsks({
    live: (id) => live.get(id),
    readNewest: (id) => Promise.resolve(page(...(pages.get(id) ?? []))),
  })
  const actions: NeedsYouPeekActions = {
    asks,
    answerApproval: vi.fn(() => Promise.resolve()),
    answerQuestion: vi.fn(() => Promise.resolve()),
  }
  const onSelectSession = vi.fn()
  const sessions = [
    chat('open-chat', 'Webhook double-charge', 'idle'),
    chat('approval-chat', 'Add zod validation', 'approval'),
    chat('question-chat', 'Currency rounding', 'input'),
  ]
  const view = (
    projectSessions: Session[] = sessions,
    request?: { request: number; direction: 1 | -1 },
  ) => (
    <Sidebar
      projects={[
        { path: 'E:\\work\\billing-service', name: 'billing-service', sessions: projectSessions },
      ]}
      activeProjectPath="E:\work\billing-service"
      activeSessionId="open-chat"
      account={undefined}
      providerName="Codex"
      collapsed={false}
      width={256}
      onWidthChange={vi.fn()}
      onClose={vi.fn()}
      onAddProject={vi.fn()}
      onNewSession={vi.fn()}
      onSelectSession={onSelectSession}
      onRenameProject={vi.fn()}
      onRemoveProject={vi.fn()}
      onTogglePin={vi.fn()}
      onRenameSession={vi.fn()}
      onDeleteSession={vi.fn()}
      onArchiveProject={vi.fn()}
      onReorderSession={vi.fn()}
      onOpenSearch={vi.fn()}
      onOpenSettings={vi.fn()}
      needsYouPeek={actions}
      needsYouPeekRequest={request}
    />
  )
  const rendered = render(view())
  return { actions, asks, pages, onSelectSession, rendered, view, sessions }
}

const band = () => screen.getByRole('region', { name: 'Needs you' })
const row = (title: string) =>
  within(band()).getByRole('button', { name: new RegExp(`^${title},`) })
const peek = () => screen.getByRole('dialog')
const press = (key: string) => fireEvent.keyDown(document.activeElement ?? peek(), { key })
const arm = () => {
  clock += 400
}

describe('Needs you rows that say what is asked', () => {
  it('shows the exact request on the second line', () => {
    setup()
    expect(row('Add zod validation').textContent).toContain('Approvepnpm add zod@4.1.2')
    expect(row('Currency rounding').textContent).toContain(
      'AnswerWhich currency rounding do we keep?',
    )
  })

  it('opens the chat with Enter and the peek with a click', () => {
    const { onSelectSession } = setup()
    fireEvent.keyDown(row('Add zod validation'), { key: 'Enter' })
    expect(onSelectSession).toHaveBeenCalledWith('approval-chat')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(row('Add zod validation'))
    expect(peek().textContent).toContain('pnpm add zod@4.1.2')
    expect(row('Add zod validation').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('the peek', () => {
  it('always shows the full command and folder, and offers only Allow once or Deny', () => {
    setup()
    fireEvent.click(row('Add zod validation'))
    const dialog = peek()
    expect(within(dialog).getByText('pnpm add zod@4.1.2')).toBeTruthy()
    expect(within(dialog).getByText('E:\\work\\billing-service')).toBeTruthy()
    expect(within(dialog).getByText('Install the validation library')).toBeTruthy()
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(buttons).toEqual(['Allow onceA', 'DenyD', 'Open chat↵'])
    expect(document.activeElement).toBe(dialog)
  })

  it('allows once with A after checking the request is still open', async () => {
    const { actions } = setup()
    fireEvent.click(row('Add zod validation'))
    // A key in the first moments is not a decision.
    press('a')
    await act(() => Promise.resolve())
    expect(actions.answerApproval).not.toHaveBeenCalled()
    arm()
    press('a')
    await waitFor(() =>
      expect(actions.answerApproval).toHaveBeenCalledWith('approval-chat', 'approval-1', 'approve'),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('denies with D and never answers a held key', async () => {
    const { actions } = setup()
    fireEvent.click(row('Add zod validation'))
    arm()
    fireEvent.keyDown(peek(), { key: 'a', repeat: true })
    await act(() => Promise.resolve())
    expect(actions.answerApproval).not.toHaveBeenCalled()
    press('d')
    await waitFor(() =>
      expect(actions.answerApproval).toHaveBeenCalledWith('approval-chat', 'approval-1', 'deny'),
    )
  })

  it('says Already answered when the request was answered elsewhere, and sends nothing', async () => {
    const { actions, pages } = setup()
    fireEvent.click(row('Add zod validation'))
    pages.set('approval-chat', [started, approval, { type: 'approval.resolved', id: 'approval-1' }])
    arm()
    press('a')
    await waitFor(() => expect(peek().textContent).toContain('Already answered'))
    expect(actions.answerApproval).not.toHaveBeenCalled()
  })

  it('says Already answered when the chat leaves the band while it is open', () => {
    const { rendered, view, sessions } = setup()
    fireEvent.click(row('Add zod validation'))
    rendered.rerender(view([sessions[0]!, { ...sessions[1]!, status: 'working' }, sessions[2]!]))
    expect(peek().textContent).toContain('Already answered')
    expect(within(peek()).queryByRole('button', { name: /Allow once/ })).toBeNull()
  })

  it('opens the chat with Enter and closes with Space or Esc', () => {
    const { onSelectSession } = setup()
    fireEvent.click(row('Add zod validation'))
    press('Enter')
    expect(onSelectSession).toHaveBeenCalledWith('approval-chat')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(row('Add zod validation'))
    press(' ')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(row('Add zod validation'))
    press('Escape')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(row('Add zod validation'))
  })

  it('picks an option with its number', async () => {
    const { actions } = setup()
    fireEvent.click(row('Currency rounding'))
    arm()
    press('2')
    await waitFor(() =>
      expect(actions.answerQuestion).toHaveBeenCalledWith('question-chat', 'input-1', {
        rounding: ['Half-up'],
      }),
    )
  })

  it('takes its own words where the question allows them', async () => {
    const { actions } = setup()
    fireEvent.click(row('Currency rounding'))
    const field = within(peek()).getByRole('textbox')
    fireEvent.change(field, { target: { value: 'Round per line, then the total' } })
    // A number typed into the answer is text, not an option.
    fireEvent.keyDown(field, { key: '1' })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() =>
      expect(actions.answerQuestion).toHaveBeenCalledWith('question-chat', 'input-1', {
        rounding: ['Round per line, then the total'],
      }),
    )
    expect(actions.answerQuestion).toHaveBeenCalledTimes(1)
  })

  it('offers only the chat for a private question', async () => {
    const { actions } = setup({ questionOverrides: { secret: true, options: null } })
    fireEvent.click(row('Currency rounding'))
    expect(peek().textContent).toContain('This asks for a private answer')
    expect(within(peek()).queryByRole('textbox')).toBeNull()
    arm()
    press('1')
    await act(() => Promise.resolve())
    expect(actions.answerQuestion).not.toHaveBeenCalled()
  })

  it('moves to the next chat that needs you on F8', () => {
    const { rendered, view, sessions } = setup()
    rendered.rerender(view(sessions, { request: 1, direction: 1 }))
    expect(peek().getAttribute('aria-label')).toBe('Add zod validation: waiting for approval')
    rendered.rerender(view(sessions, { request: 2, direction: 1 }))
    expect(peek().getAttribute('aria-label')).toBe('Currency rounding: waiting for an answer')
    rendered.rerender(view(sessions, { request: 3, direction: -1 }))
    expect(peek().getAttribute('aria-label')).toBe('Add zod validation: waiting for approval')
  })
})
