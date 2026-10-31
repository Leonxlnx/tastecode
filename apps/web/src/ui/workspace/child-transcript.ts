import { useCallback, useEffect, useState } from 'react'
import type { DomainEvent } from '@harness/contracts'
import { appendThreadDelta, type PendingThreadDeltaBatch } from '../../thread-delta-buffer.js'
import { ThreadFrameStore } from '../../thread-frame-store.js'
import {
  emptyThread,
  reduce,
  reduceDeltas,
  reduceEventLog,
  type ThreadState,
} from '../../thread-store.js'
import type { Transport } from '../../transport.js'

type SequencedEvent = { event: DomainEvent; seq?: number | undefined }

export type ChildTranscript = {
  frameStore: ThreadFrameStore
  loading: boolean
  failure?: string | undefined
  /** Reads the transcript again after a failure; stable identity. */
  retry: () => void
}

/**
 * A sub-agent's own chat, read-only: its history, then its live events from
 * `subagent.event`, reconciled by seq as Side chat does. Only an open detail
 * runs this, keyed by the child's id, so a closed one costs nothing. Streamed
 * text is applied once per frame, never per delta.
 */
export function useChildTranscript(transport: Transport, threadId: string): ChildTranscript {
  const [frameStore] = useState(() => new ThreadFrameStore(emptyThread))
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    let disposed = false
    let thread: ThreadState = emptyThread
    let lastSeq = 0
    let loadingHistory = false
    let held: SequencedEvent[] = []
    let frame: number | undefined
    let pending: PendingThreadDeltaBatch | undefined

    const publish = (next: ThreadState) => {
      thread = next
      frameStore.publish(next)
    }
    const flush = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      if (!pending || pending.events.length === 0) return
      const deltas = pending.events
      pending = undefined
      publish(reduceDeltas(thread, deltas))
    }
    const apply = ({ event, seq }: SequencedEvent) => {
      if (seq !== undefined) {
        if (seq <= lastSeq) return
        lastSeq = seq
      }
      if (event.type === 'item.delta') {
        pending = appendThreadDelta(pending, event)
        frame ??= requestAnimationFrame(flush)
        return
      }
      flush()
      publish(reduce(thread, event))
    }
    const load = () => {
      if (loadingHistory) return
      loadingHistory = true
      held = []
      const afterSeq = lastSeq
      transport
        .request('thread.history', { threadId, ...(afterSeq > 0 ? { afterSeq } : {}) })
        .then((history) => {
          if (disposed) return
          flush()
          const from = history.reset ? 0 : afterSeq
          let next = reduceEventLog(from > 0 ? thread : emptyThread, history.events, from)
          for (const entry of history.events) lastSeq = Math.max(lastSeq, entry.seq)
          if (!history.running) next = { ...next, running: false, activeTurn: undefined }
          // Events that arrived while the history was on its way, past what it held.
          const arrived = held
          held = []
          loadingHistory = false
          next = reduceEventLog(next, arrived, lastSeq)
          for (const entry of arrived) {
            if (entry.seq !== undefined) lastSeq = Math.max(lastSeq, entry.seq)
          }
          publish(next)
          setFailure(undefined)
          setLoading(false)
        })
        .catch((error: unknown) => {
          if (disposed) return
          loadingHistory = false
          held = []
          setFailure(error instanceof Error ? error.message : String(error))
          setLoading(false)
        })
    }

    const offEvents = transport.on('subagent.event', ({ threadId: id, event, seq }) => {
      if (id !== threadId) return
      if (loadingHistory) held.push({ event, seq })
      else apply({ event, seq })
    })
    const offState = transport.onState((state) => {
      if (state === 'open') load()
    })
    const offGap = transport.onSequenceGap(load)
    setLoading(true)
    load()
    return () => {
      disposed = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      offEvents()
      offState()
      offGap()
    }
  }, [attempt, frameStore, threadId, transport])

  return { frameStore, loading, failure, retry }
}
