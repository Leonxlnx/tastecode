import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Subagent } from '@harness/contracts'
import { ThreadFrameStore } from '../../thread-frame-store.js'
import { emptyThread } from '../../thread-state.js'
import type { Transport } from '../../transport.js'
import { Thread } from '../Thread.js'

const readOnly = () => undefined
/**
 * Native engines save a running agent's progress only on disk, without TasteCode child
 * events, so its detail asks again this often while someone can see it.
 */
const POLL_MS = 5_000

/** Provider-owned history, read only while its detail is open. No runtime is resumed. */
export function NativeSubagentTranscript(props: {
  threadId: string
  itemId: string
  subagent: Subagent
  transport: Transport
  children: ReactNode
}) {
  const { threadId, itemId, transport } = props
  const { state, transcriptId } = props.subagent
  const [frameStore] = useState(() => new ThreadFrameStore(emptyThread))
  const [loading, setLoading] = useState(true)
  const [empty, setEmpty] = useState(false)
  const [omitted, setOmitted] = useState(0)
  const [failure, setFailure] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  /** Items are on screen; later reads refresh them without the loading state. */
  const shown = useRef(false)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  // Reads once on open and once more when the agent finishes (its state changes); while
  // it runs, every few seconds and only while the window is visible.
  useEffect(() => {
    const running = state === 'running'
    let disposed = false
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const visible = () => document.visibilityState === 'visible'
    const schedule = () => {
      clearTimeout(timer)
      timer = undefined
      if (!disposed && running && visible()) timer = setTimeout(() => void load(), POLL_MS)
    }
    const load = async () => {
      reading = true
      try {
        const reply = await transport.request('thread.subagentTranscript', { threadId, itemId })
        if (disposed) return
        frameStore.publish({ ...emptyThread, items: reply.items, liveStart: reply.items.length })
        shown.current = true
        setEmpty(reply.items.length === 0)
        setOmitted(reply.omitted ?? 0)
        setFailure(undefined)
      } catch (error) {
        if (disposed) return
        setFailure(error instanceof Error ? error.message : String(error))
      } finally {
        reading = false
        if (!disposed) {
          setLoading(false)
          schedule()
        }
      }
    }
    // A hidden window stops asking; showing it again catches up at once.
    const onVisibility = () => {
      if (!visible()) schedule()
      else if (!reading) void load()
    }
    if (!shown.current) setLoading(true)
    void load()
    if (running) document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [attempt, frameStore, itemId, state, threadId, transcriptId, transport])

  if (empty && !loading && !failure) return props.children
  return (
    <div className="agent-detail__transcript">
      {omitted > 0 ? (
        <p className="agent-detail__note agent-detail__omitted">
          {omitted.toLocaleString()} earlier {omitted === 1 ? 'step is' : 'steps are'} not shown.
        </p>
      ) : null}
      <Thread
        frameStore={frameStore}
        threadId={threadId}
        transport={transport}
        keyboardActive={false}
        loading={loading}
        loadFailure={failure}
        onRetryLoad={retry}
        onDecide={readOnly}
        onAnswerUserInput={readOnly}
      />
    </div>
  )
}
