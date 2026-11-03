import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Subagent } from '@harness/contracts'
import { ThreadFrameStore } from '../../thread-frame-store.js'
import { emptyThread } from '../../thread-state.js'
import type { Transport } from '../../transport.js'
import { Thread } from '../Thread.js'

const readOnly = () => undefined

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
  const [failure, setFailure] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const { items } = await transport.request('thread.subagentTranscript', { threadId, itemId })
        if (disposed) return
        frameStore.publish({ ...emptyThread, items, liveStart: items.length })
        setEmpty(items.length === 0)
        setFailure(undefined)
      } catch (error) {
        if (disposed) return
        setFailure(error instanceof Error ? error.message : String(error))
      } finally {
        if (!disposed) {
          setLoading(false)
          // Native engines save progress on disk, without TasteCode child events.
          if (state === 'running') timer = setTimeout(() => void load(), 2_000)
        }
      }
    }
    setLoading(true)
    void load()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [attempt, frameStore, itemId, state, threadId, transcriptId, transport])

  if (empty && !loading && !failure) return props.children
  return (
    <div className="agent-detail__transcript">
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
