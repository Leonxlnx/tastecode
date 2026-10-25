import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import type { ApprovalRequest, ProviderId, UserInputRequest } from '@harness/contracts'
import { IconCheck as Check, IconGitBranch as Branch } from '@tabler/icons-react'
import {
  askLine,
  questionAnswerable,
  type FailedCommand,
  type NeedsYouAsk,
  type NeedsYouAsks,
  type NeedsYouAskState,
  type NeedsYouAskTarget,
} from '../needs-you-asks.js'
import { sessionSourcePresentation } from '../provider-presentation.js'
import type { Attention, NeedsYouEntry } from '../sidebar-order.js'
import { shortcutLabel, type Shortcut } from '../shortcuts.js'
import { ProviderIcon } from './ProviderIcon.js'
import { compactRelativeTime, readSessionClock, subscribeSessionClock } from './session-clock.js'
import '../styles/sidebar-peek.css'

/**
 * Design lab prototype (sidebar direction A, "Still tree peek"): a Needs you
 * row says what its chat asks, and a peek beside the rail answers it without
 * leaving the chat you are in. Everything here is provider-neutral; it reads
 * the same approval, question and failure shapes the transcript does.
 */
export type NeedsYouPeekActions = {
  asks: NeedsYouAsks
  /** The transcript card's own call. Only Allow once or Deny ever come from here. */
  answerApproval: (
    threadId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
  ) => Promise<void>
  answerQuestion: (
    threadId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ) => Promise<void>
  /** The catalog's name for a model id the chat reported, when the catalog knows it. */
  modelName?: ((provider: ProviderId, model: string) => string | undefined) | undefined
}

export function askTarget(entry: NeedsYouEntry): NeedsYouAskTarget {
  return {
    id: entry.session.id,
    attention: entry.attention,
    since: entry.session.statusSince ?? entry.session.createdAt,
  }
}

function useAsk(asks: NeedsYouAsks, id: string): NeedsYouAskState | undefined {
  const read = useCallback(() => asks.get(id), [asks, id])
  return useSyncExternalStore(asks.subscribe, read, read)
}

function useClock(): number {
  return useSyncExternalStore(subscribeSessionClock, readSessionClock, readSessionClock)
}

/**
 * A two-line band row: the chat and how long it has waited, then what it asks.
 * Click or Space opens the peek, Enter opens the chat. The state dot stays on
 * the left and never hides under the pointer.
 */
export const NeedsYouAskRow = memo(function NeedsYouAskRow(props: {
  entry: NeedsYouEntry
  projectName: string
  asks: NeedsYouAsks
  peeked: boolean
  onPeek: (entry: NeedsYouEntry, projectName: string) => void
  onOpenChat: (id: string) => void
  onMarkSessionRead: ((id: string) => void) | undefined
}) {
  const { session, attention } = props.entry
  const state = useAsk(props.asks, session.id)
  const now = useClock()
  const line = askLine(state, attention)
  const markRead =
    props.onMarkSessionRead && attention === 'failed' ? props.onMarkSessionRead : undefined
  const since = session.statusSince ?? session.createdAt
  const label = `${session.title}, ${attentionLabel(attention)}, ${props.projectName}. ${[line.verb, line.object].filter(Boolean).join(' ')}`
  return (
    <li
      className={`sessrow needs-band__row needs-band__row--ask${props.peeked ? ' is-peeked' : ''}${session.unread ? ' is-unread' : ''}${markRead ? ' has-action' : ''}`}
      data-attention={attention}
      data-peek-id={session.id}
    >
      <button
        type="button"
        className="sess sess--ask"
        aria-label={label}
        title={`${session.title} · ${props.projectName}`}
        aria-haspopup="dialog"
        aria-expanded={props.peeked}
        onClick={() => props.onPeek(props.entry, props.projectName)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          props.onOpenChat(session.id)
        }}
      >
        <span className="sess__mark" aria-hidden>
          <span
            className={`sess__status-dot ${attention === 'failed' ? 'is-failed' : 'is-attention'}`}
          />
        </span>
        <span className="sess__ask">
          <span className="sess__ask-head">
            <span className="sess__title">{session.title}</span>
            {since > 0 ? (
              <span className="sess__time" aria-hidden>
                {compactRelativeTime(since, now)}
              </span>
            ) : null}
          </span>
          <span className="sess__ask-line" data-state={state?.status ?? 'none'}>
            <span className="sess__ask-verb">{line.verb}</span>
            {line.object ? (
              <span className={`sess__ask-object${line.code ? ' is-code' : ''}`}>
                {line.object}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {markRead ? (
        <span className="sess__actions">
          <button
            type="button"
            className="sess__action"
            onClick={() => markRead(session.id)}
            aria-label={`Mark ${session.title} as read`}
            title="Mark as read"
          >
            <Check size={14} aria-hidden />
          </button>
        </span>
      ) : null}
    </li>
  )
})

function attentionLabel(attention: Attention): string {
  switch (attention) {
    case 'approval':
      return 'waiting for approval'
    case 'input':
      return 'waiting for an answer'
    case 'failed':
      return 'failed'
  }
}

/** Keys pressed this soon after the peek opens are not answers: a held or doubled key is not a decision. */
const ARM_MS = 250
const PEEK_GAP = 8
const EDGE = 8

type Sending = { label: string } | undefined

/**
 * The peek beside the rail. It shows the exact request: the full command and
 * the folder it runs in, the question with its options, or the failure. It
 * answers with Allow once or Deny only, never for the whole session, and a
 * private question only offers the chat itself.
 */
export function SidebarPeek(props: {
  entry: NeedsYouEntry
  projectName: string
  /** Gone from the band while open: answered somewhere else. */
  gone: boolean
  actions: NeedsYouPeekActions
  container: HTMLElement | null
  anchor: () => HTMLElement | null
  nextShortcut: Shortcut | null
  macOS: boolean
  onClose: (returnFocus: boolean) => void
  onOpenChat: (id: string) => void
  onAnswered: (id: string) => void
  onMarkRead: ((id: string) => void) | undefined
}) {
  const { session, attention } = props.entry
  const id = session.id
  const state = useAsk(props.actions.asks, id)
  const now = useClock()
  const panel = useRef<HTMLDivElement>(null)
  const openedAt = useRef(Date.now())
  const lastTop = useRef<number | undefined>(undefined)
  const [sending, setSending] = useState<Sending>()
  const [sendError, setSendError] = useState<string>()
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [text, setText] = useState('')
  const target = askTarget(props.entry)
  // While this peek's own answer is on its way the row can leave first; that is
  // not someone else answering.
  const answeredElsewhere = props.gone && !sending
  const shown: NeedsYouAskState | undefined = answeredElsewhere
    ? { status: 'ready', ask: { kind: 'answered' } }
    : state
  const ask: NeedsYouAsk | undefined = shown?.status === 'ready' ? shown.ask : undefined

  // A new chat in the same peek starts clean.
  useEffect(() => {
    openedAt.current = Date.now()
    setSending(undefined)
    setSendError(undefined)
    setStep(0)
    setAnswers({})
    setText('')
    panel.current?.focus({ preventScroll: true })
  }, [id])

  const position = useCallback(() => {
    const node = panel.current
    const container = props.container
    if (!node || !container) return
    const box = container.getBoundingClientRect()
    const rail = container.querySelector('.rail')?.getBoundingClientRect()
    const row = props.anchor()?.getBoundingClientRect()
    const height = node.offsetHeight
    const wanted = row ? row.top - box.top - 6 : (lastTop.current ?? EDGE)
    const top = Math.max(EDGE, Math.min(wanted, box.height - height - EDGE))
    if (row) lastTop.current = wanted
    node.style.top = `${Math.round(top)}px`
    node.style.left = `${Math.round((rail ? rail.right - box.left : 0) + PEEK_GAP)}px`
  }, [props.anchor, props.container])

  useLayoutEffect(position)
  useEffect(() => {
    const container = props.container
    window.addEventListener('resize', position)
    container?.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      container?.removeEventListener('scroll', position, true)
    }
  }, [position, props.container])

  // A press anywhere but the peek or a band row puts it away.
  const onClose = props.onClose
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const node = event.target as Element | null
      if (!node || panel.current?.contains(node) || node.closest?.('.needs-band__row')) return
      onClose(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [onClose])

  const armed = () => Date.now() - openedAt.current >= ARM_MS

  const send = async (label: string, run: () => Promise<void>) => {
    if (sending) return
    setSending({ label })
    setSendError(undefined)
    try {
      // The check before an answer: a request someone answered meanwhile gets
      // "Already answered", never a second answer the agent would drop.
      const current = await props.actions.asks.refresh(target, true)
      if (current.status === 'ready' && current.ask.kind === 'answered') {
        setSending(undefined)
        return
      }
      await run()
      props.actions.asks.settle(id, label)
      props.onAnswered(id)
    } catch (error) {
      setSending(undefined)
      setSendError(error instanceof Error ? error.message : String(error))
    }
  }

  const decide = (request: ApprovalRequest, decision: 'approve' | 'deny') =>
    void send(decision === 'approve' ? 'Allowed once' : 'Denied', () =>
      props.actions.answerApproval(id, request.id, decision),
    )

  const answer = (request: UserInputRequest, value: string) => {
    const question = request.questions[step]
    if (!question || !value.trim()) return
    const next = { ...answers, [question.id]: [value.trim()] }
    if (step < request.questions.length - 1) {
      setAnswers(next)
      setStep(step + 1)
      setText('')
      panel.current?.focus({ preventScroll: true })
      return
    }
    void send('Answered', () => props.actions.answerQuestion(id, request.id, next))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    const field = event.target instanceof HTMLInputElement
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      props.onClose(true)
      return
    }
    if (field) return
    const onPanel = event.target === event.currentTarget
    if (event.key === 'Enter' && onPanel) {
      event.preventDefault()
      props.onOpenChat(id)
      return
    }
    if (event.key === ' ' && onPanel) {
      event.preventDefault()
      props.onClose(true)
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || !armed() || sending)
      return
    const key = event.key.toLowerCase()
    if (ask?.kind === 'approval') {
      if (key === 'a') {
        event.preventDefault()
        decide(ask.request, 'approve')
      } else if (key === 'd') {
        event.preventDefault()
        decide(ask.request, 'deny')
      }
      return
    }
    if (ask?.kind === 'question' && questionAnswerable(ask.request) && /^[1-9]$/.test(key)) {
      const option = ask.request.questions[step]?.options?.[Number(key) - 1]
      if (!option) return
      event.preventDefault()
      answer(ask.request, option.label)
    }
  }

  const source = sessionSourcePresentation(session.provider, session.agent)
  const model =
    ask && ask.kind !== 'answered' && ask.model
      ? (props.actions.modelName?.(session.provider, ask.model) ?? ask.model)
      : undefined
  const since = session.statusSince ?? session.createdAt
  const next = props.nextShortcut ? shortcutLabel(props.nextShortcut, props.macOS) : undefined

  return (
    <div
      ref={panel}
      className="peek"
      role="dialog"
      aria-label={`${session.title}: ${attentionLabel(attention)}`}
      tabIndex={-1}
      data-attention={attention}
      onKeyDown={onKeyDown}
    >
      <header className="peek__head">
        <p className="peek__meta">
          <span className="peek__source">
            <ProviderIcon mark={source.mark} size={12} />
            <span>{model ?? source.label}</span>
          </span>
          <span className="peek__sep" aria-hidden>
            ·
          </span>
          <span className="peek__project">{props.projectName}</span>
          {session.worktreeBranch ? (
            <span className="peek__branch">
              <Branch size={11} aria-hidden />
              <span>{session.worktreeBranch}</span>
            </span>
          ) : null}
          {since > 0 ? <span className="peek__time">{compactRelativeTime(since, now)}</span> : null}
        </p>
        <h2 className="peek__title">{session.title}</h2>
      </header>

      <PeekBody
        attention={attention}
        state={shown}
        projectPath={props.entry.projectPath}
        step={step}
        text={text}
        sending={sending}
        onText={setText}
        onAnswer={answer}
      />

      <footer className="peek__actions">
        <PeekActions
          ask={ask}
          sending={sending}
          step={step}
          onDecide={decide}
          onOpenChat={() => props.onOpenChat(id)}
          onMarkRead={
            props.onMarkRead && attention === 'failed' && !props.gone
              ? () => props.onMarkRead?.(id)
              : undefined
          }
          onRetry={
            shown?.status === 'error' ? () => void props.actions.asks.refresh(target) : undefined
          }
        />
      </footer>
      {sendError ? (
        <p className="peek__error" role="alert">
          Could not send. Open the chat to answer there.
        </p>
      ) : null}
      <p className="peek__keys" aria-hidden>
        <span>
          <kbd>Esc</kbd> close
        </span>
        {next ? (
          <span>
            <kbd>{next}</kbd> next that needs you
          </span>
        ) : null}
      </p>
    </div>
  )
}

function PeekBody(props: {
  attention: Attention
  state: NeedsYouAskState | undefined
  projectPath: string
  step: number
  text: string
  sending: Sending
  onText: (text: string) => void
  onAnswer: (request: UserInputRequest, value: string) => void
}) {
  const { state } = props
  if (!state || state.status === 'loading') {
    return (
      <div className="peek__body" aria-busy>
        <p className="peek__status">
          <span
            className={`peek__dot ${props.attention === 'failed' ? 'is-failed' : 'is-attention'}`}
          />
          {props.attention === 'approval'
            ? 'Reading what it wants to run…'
            : 'Reading what it asks…'}
        </p>
        <div className="peek__skeleton" aria-hidden>
          <span />
          <span />
        </div>
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="peek__body">
        <p className="peek__status">
          <span className="peek__dot is-muted" />
          Could not read what this chat asks.
        </p>
        <p className="peek__note">Open the chat to see it there.</p>
      </div>
    )
  }
  const { ask } = state
  switch (ask.kind) {
    case 'answered':
      return (
        <div className="peek__body">
          <p className="peek__status">
            <Check size={13} className="peek__check" aria-hidden />
            {ask.reply ?? 'Already answered'}
          </p>
          {ask.reply ? null : (
            <p className="peek__note">This request was answered somewhere else.</p>
          )}
        </div>
      )
    case 'approval':
      return <ApprovalBody request={ask.request} more={ask.more} projectPath={props.projectPath} />
    case 'question':
      return (
        <QuestionBody
          request={ask.request}
          more={ask.more}
          step={props.step}
          text={props.text}
          sending={props.sending}
          onText={props.onText}
          onAnswer={(value) => props.onAnswer(ask.request, value)}
        />
      )
    case 'failure':
      return <FailureBody message={ask.message} command={ask.command} />
  }
}

function ApprovalBody(props: { request: ApprovalRequest; more: number; projectPath: string }) {
  const { request } = props
  return (
    <div className="peek__body">
      <p className="peek__status">
        <span className="peek__dot is-attention" />
        {approvalStatus(request)}
      </p>
      {request.command ? (
        <pre className="peek__code">
          {request.kind === 'command' ? (
            <span className="peek__prompt" aria-hidden>
              ${' '}
            </span>
          ) : null}
          {request.command}
        </pre>
      ) : null}
      {request.path ? <p className="peek__path">{request.path}</p> : null}
      {request.cwd ? (
        <p className="peek__folder">
          in <span>{request.cwd}</span>
        </p>
      ) : (
        <p className="peek__folder">
          Folder not reported. The chat works in <span>{props.projectPath}</span>
        </p>
      )}
      {request.reason ? <p className="peek__reason">{request.reason}</p> : null}
      {props.more > 0 ? (
        <p className="peek__note">
          {props.more === 1
            ? 'One more request waits in this chat.'
            : `${props.more} more requests wait in this chat.`}
        </p>
      ) : null}
    </div>
  )
}

function approvalStatus(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command':
      return 'Wants to run a command'
    case 'file_change':
      return 'Wants to write to your files'
    case 'permissions':
      return 'Wants extra access'
  }
}

function QuestionBody(props: {
  request: UserInputRequest
  more: number
  step: number
  text: string
  sending: Sending
  onText: (text: string) => void
  onAnswer: (value: string) => void
}) {
  const { request } = props
  const question = request.questions[props.step] ?? request.questions[0]!
  const answerable = questionAnswerable(request)
  const options = question.options ?? []
  const free = answerable && (question.allowOther || options.length === 0)
  const count = request.questions.length
  return (
    <div className="peek__body">
      <p className="peek__status">
        <span className="peek__dot is-attention" />
        Asks you
        {count > 1 ? (
          <span className="peek__count">
            Question {props.step + 1} of {count}
          </span>
        ) : null}
      </p>
      <p className="peek__question">{question.question}</p>
      {options.length > 0 ? (
        <ol className="peek__options">
          {options.map((option, index) => (
            <li key={option.label}>
              <button
                type="button"
                className="peek__option"
                disabled={!answerable || Boolean(props.sending) || index > 8}
                onClick={() => props.onAnswer(option.label)}
                title={option.description}
              >
                <kbd>{index < 9 ? index + 1 : ''}</kbd>
                <span className="peek__option-label">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="peek__option-note">{option.description}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {free ? (
        <input
          className="peek__input"
          type="text"
          value={props.text}
          placeholder="Answer in your own words…"
          aria-label={`Your answer: ${question.question}`}
          disabled={Boolean(props.sending)}
          onChange={(event) => props.onText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            event.stopPropagation()
            props.onAnswer(props.text)
          }}
        />
      ) : null}
      {!answerable ? (
        <p className="peek__note">
          {request.questions.some((candidate) => candidate.secret)
            ? 'This asks for a private answer. Answer it in the chat.'
            : 'This takes more than one choice. Answer it in the chat.'}
        </p>
      ) : null}
      {props.sending ? <p className="peek__note">Sending…</p> : null}
      {props.more > 0 ? (
        <p className="peek__note">
          {props.more === 1
            ? 'One more question set waits.'
            : `${props.more} more question sets wait.`}
        </p>
      ) : null}
    </div>
  )
}

function FailureBody(props: { message: string | undefined; command: FailedCommand | undefined }) {
  const { command } = props
  return (
    <div className="peek__body">
      <p className="peek__status">
        <span className="peek__dot is-failed" />
        {command ? `Failed · exit ${command.exitCode}` : 'Failed'}
      </p>
      {command ? (
        <pre className="peek__code">
          <span className="peek__prompt" aria-hidden>
            ${' '}
          </span>
          {command.command}
          {command.tail.length > 0 ? (
            <span className="peek__tail">{'\n' + command.tail.join('\n')}</span>
          ) : null}
        </pre>
      ) : null}
      {props.message && !command ? <pre className="peek__code is-text">{props.message}</pre> : null}
      {!props.message && !command ? (
        <p className="peek__note">TasteCode did not see why it stopped. The chat shows the turn.</p>
      ) : null}
    </div>
  )
}

function PeekActions(props: {
  ask: NeedsYouAsk | undefined
  sending: Sending
  step: number
  onDecide: (request: ApprovalRequest, decision: 'approve' | 'deny') => void
  onOpenChat: () => void
  onMarkRead: (() => void) | undefined
  onRetry: (() => void) | undefined
}) {
  const { ask } = props
  const approval = ask?.kind === 'approval' ? ask.request : undefined
  return (
    <>
      {approval ? (
        <span className="peek__group">
          <button
            type="button"
            className="peek__button is-primary"
            disabled={Boolean(props.sending)}
            onClick={() => props.onDecide(approval, 'approve')}
          >
            {props.sending?.label === 'Allowed once' ? 'Allowing…' : 'Allow once'}
            <kbd>A</kbd>
          </button>
          <button
            type="button"
            className="peek__button"
            disabled={Boolean(props.sending)}
            onClick={() => props.onDecide(approval, 'deny')}
          >
            Deny
            <kbd>D</kbd>
          </button>
        </span>
      ) : null}
      {props.onMarkRead ? (
        <button type="button" className="peek__button" onClick={props.onMarkRead}>
          Mark as read
        </button>
      ) : null}
      {props.onRetry ? (
        <button type="button" className="peek__button" onClick={props.onRetry}>
          Try again
        </button>
      ) : null}
      <button type="button" className="peek__button is-quiet peek__open" onClick={props.onOpenChat}>
        Open chat
        <kbd>↵</kbd>
      </button>
    </>
  )
}
