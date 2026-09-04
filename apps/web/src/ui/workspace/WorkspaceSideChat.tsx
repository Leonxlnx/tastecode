import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ApprovalDecision, ApprovalMode, DomainEvent } from '@harness/contracts'
import {
  IconArrowUp as ArrowUp,
  IconAlertCircle as CircleAlert,
  IconSquare as Square,
} from '@tabler/icons-react'
import { parseSideChatCommand } from '../../side-chat-command.js'
import {
  appendBackgroundThreadDelta,
  appendThreadDelta,
  shouldDrainBackgroundDeltas,
  type PendingThreadDeltaBatch,
} from '../../thread-delta-buffer.js'
import {
  activeTurnActivityIndices,
  activeTurnIsSearching,
  beginOptimisticTurn,
  emptyThread,
  reduce,
  reduceDeltas,
  reduceEventLog,
  removeOptimisticMessage,
  type ThreadState,
} from '../../thread-store.js'
import { ThreadFrameStore } from '../../thread-frame-store.js'
import type { Transport } from '../../transport.js'
import { IconMorph } from '../IconMorph.js'
import { Thread } from '../Thread.js'
import { WorkspaceEmptyState } from './WorkspaceEmptyState.js'

export type SideChatParentStatus = 'idle' | 'working' | 'approval' | 'input' | 'failed'

export type SideChatPromptRequest = {
  parentThreadId: string
  text: string
  attachments: string[]
  request: number
}

export type SideChatStartOptions = {
  model?: string | undefined
  effort?: string | undefined
  serviceTier?: string | undefined
  approval?: ApprovalMode | undefined
}

type SequencedEvent = { event: DomainEvent; seq?: number | undefined }
let submissionSequence = 0

const SideChatThread = memo(function SideChatThread(props: {
  frameStore: ThreadFrameStore
  threadId?: string | undefined
  transport: Transport
  onDecide: (id: string, decision: ApprovalDecision) => void
  onAnswerUserInput: (id: string, answers: Record<string, string[]>) => void
}) {
  const thread = useSyncExternalStore(
    props.frameStore.subscribeStructure,
    props.frameStore.getStructureSnapshot,
    props.frameStore.getStructureSnapshot,
  )
  const reviews = useMemo(() => Object.values(thread.reviews), [thread.reviews])
  const activeActivityIndices = useMemo(
    () => activeTurnActivityIndices(thread.items, thread.activeTurn?.id, thread.liveStart),
    [thread.items, thread.activeTurn?.id, thread.liveStart],
  )
  const searching = activeTurnIsSearching(
    thread.items,
    thread.activeTurn?.id,
    thread.liveItems,
    thread.liveStart,
    activeActivityIndices,
  )

  return (
    <Thread
      frameStore={props.frameStore}
      items={thread.items}
      liveItems={thread.liveItems}
      itemVersion={thread.itemVersion}
      liveStart={thread.liveStart}
      running={thread.running}
      searching={searching}
      activeActivityIndices={activeActivityIndices}
      activeTurn={thread.activeTurn}
      turnTiming={thread.turnTiming}
      plan={thread.plan}
      diff={thread.diff}
      threadId={props.threadId}
      transport={props.transport}
      approvals={thread.approvals}
      userInputs={thread.userInputs}
      reviews={reviews}
      keyboardActive={false}
      onDecide={props.onDecide}
      onAnswerUserInput={props.onAnswerUserInput}
    />
  )
})

export function WorkspaceSideChat(props: {
  active: boolean
  projectName?: string | undefined
  parentThreadId?: string | undefined
  parentStatus: SideChatParentStatus
  transport: Transport
  startOptions: SideChatStartOptions
  promptRequest?: SideChatPromptRequest | undefined
}) {
  const [draft, setDraft] = useState('')
  const [sideThreadId, setSideThreadId] = useState<string>()
  const [thread, setThread] = useState<ThreadState>(emptyThread)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string>()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const threadRef = useRef(thread)
  const activeRef = useRef(props.active)
  const flushDeltasRef = useRef<(() => void) | undefined>(undefined)
  const frameStoreRef = useRef<ThreadFrameStore | null>(null)
  frameStoreRef.current ??= new ThreadFrameStore(emptyThread)
  const sideThreadIdRef = useRef(sideThreadId)
  const sideParentRef = useRef<string | undefined>(undefined)
  const startPromiseRef = useRef<Promise<string> | undefined>(undefined)
  const generationRef = useRef(0)
  const lastSeqRef = useRef(0)
  const loadingHistoryRef = useRef(false)
  const historyBufferRef = useRef<SequencedEvent[]>([])
  const promptRequestRef = useRef(0)
  activeRef.current = props.active
  sideThreadIdRef.current = sideThreadId

  const replaceThread = useCallback((next: ThreadState) => {
    threadRef.current = next
    frameStoreRef.current?.publish(next)
    setThread(next)
  }, [])

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    const previousId = sideThreadIdRef.current
    if (previousId) {
      void props.transport
        .request('sideChat.close', { threadId: previousId })
        .catch(() => undefined)
    }
    sideThreadIdRef.current = undefined
    sideParentRef.current = props.parentThreadId
    startPromiseRef.current = undefined
    lastSeqRef.current = 0
    historyBufferRef.current = []
    setSideThreadId(undefined)
    replaceThread(emptyThread)
    setStarting(false)
    setStopping(false)
    setError(undefined)

    return () => {
      if (generationRef.current === generation) generationRef.current += 1
      const id = sideThreadIdRef.current
      if (id && sideParentRef.current === props.parentThreadId) {
        sideThreadIdRef.current = undefined
        void props.transport.request('sideChat.close', { threadId: id }).catch(() => undefined)
      }
    }
  }, [props.parentThreadId, props.transport, replaceThread])

  useEffect(() => {
    let frame: number | undefined
    let pendingDeltas: PendingThreadDeltaBatch | undefined

    const flushDeltas = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      if (!pendingDeltas || pendingDeltas.events.length === 0) return
      const deltas = pendingDeltas.events
      pendingDeltas = undefined
      const current = threadRef.current
      const next = reduceDeltas(current, deltas)
      threadRef.current = next
      frameStoreRef.current?.publish(next)
      // A normal delta changes only the live overlay. An early delta can add
      // the first row, which must mount the conversation container once.
      if (next.items !== current.items) setThread(next)
    }
    const apply = ({ event, seq }: SequencedEvent) => {
      if (seq !== undefined) {
        if (seq <= lastSeqRef.current) return
        lastSeqRef.current = seq
      }
      if (event.type === 'item.delta') {
        const active = activeRef.current
        pendingDeltas = active
          ? appendThreadDelta(pendingDeltas, event)
          : appendBackgroundThreadDelta(pendingDeltas, event)
        if (active) frame ??= requestAnimationFrame(flushDeltas)
        else if (shouldDrainBackgroundDeltas(pendingDeltas)) flushDeltas()
        return
      }
      flushDeltas()
      replaceThread(reduce(threadRef.current, event))
    }
    flushDeltasRef.current = flushDeltas

    const offEvents = props.transport.on('sideChat.event', ({ threadId, event, seq }) => {
      if (threadId !== sideThreadIdRef.current) return
      if (loadingHistoryRef.current) {
        historyBufferRef.current.push({ event, seq })
        return
      }
      apply({ event, seq })
    })
    const syncTail = () => {
      const id = sideThreadIdRef.current
      if (!id || loadingHistoryRef.current) return
      loadingHistoryRef.current = true
      historyBufferRef.current = []
      const afterSeq = lastSeqRef.current
      void props.transport
        .request('thread.history', { threadId: id, afterSeq })
        .then((history) => {
          if (sideThreadIdRef.current !== id) return
          flushDeltas()
          let next = reduceEventLog(threadRef.current, history.events, afterSeq)
          for (const entry of history.events)
            lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq)
          next = reduceEventLog(next, historyBufferRef.current, lastSeqRef.current)
          for (const entry of historyBufferRef.current) {
            if (entry.seq !== undefined)
              lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq)
          }
          replaceThread(history.running ? next : { ...next, running: false, activeTurn: undefined })
        })
        .catch(() => undefined)
        .finally(() => {
          loadingHistoryRef.current = false
          historyBufferRef.current = []
        })
    }
    const offState = props.transport.onState((state) => {
      if (state === 'open') syncTail()
    })
    const offGap = props.transport.onSequenceGap(syncTail)

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      pendingDeltas = undefined
      if (flushDeltasRef.current === flushDeltas) flushDeltasRef.current = undefined
      offEvents()
      offState()
      offGap()
    }
  }, [props.transport, replaceThread])

  useEffect(() => {
    if (props.active) flushDeltasRef.current?.()
  }, [props.active])

  const ensureSideThread = useCallback(async (): Promise<string> => {
    const existing = sideThreadIdRef.current
    if (existing) return existing
    if (startPromiseRef.current) return startPromiseRef.current
    const parentThreadId = props.parentThreadId
    if (!parentThreadId || parentThreadId.startsWith('pending:')) {
      throw new Error('Start the main chat before opening a side chat.')
    }

    const generation = generationRef.current
    setStarting(true)
    setError(undefined)
    const pending = props.transport
      .request('sideChat.start', { parentThreadId, ...props.startOptions })
      .then(async ({ threadId }) => {
        if (generationRef.current !== generation || sideParentRef.current !== parentThreadId) {
          void props.transport.request('sideChat.close', { threadId }).catch(() => undefined)
          throw new Error('Side chat was closed before it finished starting.')
        }
        sideThreadIdRef.current = threadId
        setSideThreadId(threadId)
        loadingHistoryRef.current = true
        historyBufferRef.current = []
        const history = await props.transport.request('thread.history', { threadId })
        if (sideThreadIdRef.current !== threadId) return threadId
        let next = reduceEventLog(emptyThread, history.events)
        for (const entry of history.events)
          lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq)
        next = reduceEventLog(next, historyBufferRef.current, lastSeqRef.current)
        for (const entry of historyBufferRef.current) {
          if (entry.seq !== undefined) lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq)
        }
        replaceThread(history.running ? next : { ...next, running: false, activeTurn: undefined })
        return threadId
      })
      .finally(() => {
        loadingHistoryRef.current = false
        historyBufferRef.current = []
        if (startPromiseRef.current === pending) startPromiseRef.current = undefined
        if (generationRef.current === generation) setStarting(false)
      })
    startPromiseRef.current = pending
    return pending
  }, [props.parentThreadId, props.startOptions, props.transport, replaceThread])

  useEffect(() => {
    if (!props.active || !props.parentThreadId || props.parentThreadId.startsWith('pending:'))
      return
    // One frame avoids starting a provider during React Strict Mode's
    // mount-cleanup-mount probe; the probe cancels this frame before it runs.
    const frame = requestAnimationFrame(() => {
      void ensureSideThread().catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [ensureSideThread, props.active, props.parentThreadId])

  const sendPrompt = useCallback(
    async (rawText: string, attachments: string[] = []) => {
      const text = rawText.trim()
      if (!text) return
      if (threadRef.current.running) {
        setDraft((current) => (current.trim() ? `${current.trimEnd()}\n${text}` : text))
        setError('Temporary chat is still working. Your message is ready when it finishes.')
        return
      }
      if (parseSideChatCommand(text)) {
        setError('You are already in a temporary chat. Nested temporary chats are not available.')
        return
      }

      const clientSubmissionId = `side:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${submissionSequence++}`}`
      try {
        const threadId = await ensureSideThread()
        const optimistic = beginOptimisticTurn(
          threadRef.current,
          text,
          clientSubmissionId,
          Date.now(),
          attachments,
        )
        replaceThread(optimistic)
        await props.transport.request('thread.sendTurn', {
          threadId,
          text,
          clientSubmissionId,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(props.startOptions.model ? { model: props.startOptions.model } : {}),
          ...(props.startOptions.effort ? { effort: props.startOptions.effort } : {}),
          ...(props.startOptions.serviceTier
            ? { serviceTier: props.startOptions.serviceTier }
            : {}),
        })
        setError(undefined)
      } catch (reason) {
        const next = removeOptimisticMessage(threadRef.current, clientSubmissionId)
        replaceThread({ ...next, running: false, activeTurn: undefined })
        setDraft((current) => current || text)
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    },
    [ensureSideThread, props.startOptions, props.transport, replaceThread],
  )

  useEffect(() => {
    const request = props.promptRequest
    if (!request || request.parentThreadId !== props.parentThreadId) return
    if (request.request <= promptRequestRef.current) return
    promptRequestRef.current = request.request
    if (!request.text.trim()) {
      requestAnimationFrame(() => textarea.current?.focus())
      return
    }
    void sendPrompt(request.text, request.attachments)
  }, [props.parentThreadId, props.promptRequest, sendPrompt])

  const submit = () => {
    const text = draft.trim()
    if (!text || thread.running || starting) return
    setDraft('')
    void sendPrompt(text)
  }

  const interrupt = () => {
    const threadId = sideThreadIdRef.current
    if (!threadId || stopping) return
    setStopping(true)
    void props.transport
      .request('thread.interrupt', { threadId })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setStopping(false))
  }

  const decide = useCallback(
    (id: string, decision: ApprovalDecision) => {
      const threadId = sideThreadIdRef.current
      if (!threadId) return
      void props.transport
        .request('thread.respondToApproval', { threadId, approvalId: id, decision })
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
    },
    [props.transport],
  )

  const answer = useCallback(
    (id: string, answers: Record<string, string[]>) => {
      const threadId = sideThreadIdRef.current
      if (!threadId) return
      void props.transport
        .request('thread.respondToUserInput', { threadId, requestId: id, answers })
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
    },
    [props.transport],
  )

  if (!props.parentThreadId) {
    return (
      <WorkspaceEmptyState
        kind="chat"
        title="Start a chat first"
        detail="Temporary chat uses the active conversation without interrupting it."
      />
    )
  }

  const hasConversation = thread.items.length > 0 || thread.running

  return (
    <div className="workspace-side-chat">
      <div className="workspace-side-chat__conversation" aria-live="polite">
        {error ? (
          <div className="workspace-side-chat__error" role="alert">
            <CircleAlert size={13} aria-hidden />
            <span>{error}</span>
          </div>
        ) : null}
        {hasConversation && props.active ? (
          <SideChatThread
            frameStore={frameStoreRef.current}
            threadId={sideThreadId}
            transport={props.transport}
            onDecide={decide}
            onAnswerUserInput={answer}
          />
        ) : !hasConversation && !starting ? (
          <WorkspaceEmptyState
            kind="chat"
            title="Start a temporary chat"
            detail="It uses the current conversation as hidden context and is erased when this tab closes."
          />
        ) : null}
      </div>

      <div className="workspace-side-chat__composer">
        <textarea
          ref={textarea}
          rows={3}
          value={draft}
          aria-label="Message temporary chat"
          placeholder={starting ? 'Starting temporary chat…' : 'Do anything'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            submit()
          }}
        />
        <button
          type="button"
          aria-label={thread.running ? 'Stop temporary chat' : 'Send message'}
          disabled={thread.running ? !sideThreadId || stopping : !draft.trim() || starting}
          onClick={thread.running ? interrupt : submit}
        >
          <IconMorph active={thread.running ? 1 : 0}>
            <ArrowUp size={15} aria-hidden />
            <Square size={12} fill="currentColor" aria-hidden />
          </IconMorph>
        </button>
      </div>
    </div>
  )
}
