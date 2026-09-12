import { useCallback, useEffect, useReducer, useRef } from 'react'

type ArchiveJob = {
  id: string
  commit: () => Promise<void>
  state: 'pending' | 'committing'
}

/** Delay destructive archive work while keeping close/reload behavior deterministic. */
export function useDeferredArchiveQueue(delayMs: number) {
  const jobs = useRef(new Map<string, ArchiveJob>())
  const snapshot = useRef({ hiddenIds: [] as string[], pendingIds: [] as string[] })
  const mounted = useRef(true)
  const [, render] = useReducer((version: number) => version + 1, 0)

  const refresh = useCallback(() => {
    snapshot.current = {
      hiddenIds: [...jobs.current.keys()],
      pendingIds: [...jobs.current.values()]
        .filter((job) => job.state === 'pending')
        .map((job) => job.id),
    }
    if (mounted.current) render()
  }, [])

  const commitPending = useCallback(() => {
    const pending = [...jobs.current.values()].filter((job) => job.state === 'pending')
    if (!pending.length) return
    for (const job of pending) job.state = 'committing'
    refresh()
    void (async () => {
      for (const job of pending) {
        try {
          await job.commit()
        } catch {
          // The owner reports and reconciles failures; one job must not block the rest.
        } finally {
          jobs.current.delete(job.id)
          refresh()
        }
      }
    })()
  }, [refresh])

  const queue = useCallback(
    (id: string, commit: () => Promise<void>) => {
      jobs.current.set(id, { id, commit, state: 'pending' })
      refresh()
    },
    [refresh],
  )

  const undo = useCallback(() => {
    const pending = [...jobs.current.values()].filter((job) => job.state === 'pending')
    for (const job of pending) jobs.current.delete(job.id)
    refresh()
    return pending.at(-1)?.id
  }, [refresh])

  const { hiddenIds, pendingIds } = snapshot.current

  useEffect(() => {
    if (!pendingIds.length) return
    const timeout = globalThis.setTimeout(commitPending, delayMs)
    return () => globalThis.clearTimeout(timeout)
  }, [commitPending, delayMs, pendingIds.join('\0')])

  useEffect(() => {
    const flush = () => commitPending()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      mounted.current = false
      commitPending()
    }
  }, [commitPending])

  return { hiddenIds, pendingIds, queue, undo }
}
