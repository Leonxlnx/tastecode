import { useCallback, useEffect, useRef } from 'react'

/** Keep visible rows on screen until their archive exit finishes. */
export function useArchiveMotion() {
  const pending = useRef(new Map<string, Promise<void>>())
  const active = useRef(new Set<Animation>())
  useEffect(
    () => () => {
      for (const animation of active.current) animation.cancel()
    },
    [],
  )
  return useCallback((ids: string[], commit: (ids: string[]) => void) => {
    const fresh = ids.filter((id) => !pending.current.has(id))
    if (!fresh.length) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-archive-session-id]'))
    const waits = fresh.map((id) => {
      const motions = reduced
        ? []
        : rows
            .filter((row) => row.dataset['archiveSessionId'] === id && row.animate)
            .map((row) => {
              const animation = row.animate(
                [
                  { opacity: 1, transform: 'translateX(0)' },
                  { opacity: 0, transform: 'translateX(-12px)' },
                ],
                { duration: 160, easing: 'ease-out' },
              )
              active.current.add(animation)
              return animation.finished
                .catch(() => undefined)
                .finally(() => {
                  active.current.delete(animation)
                })
            })
      const wait = Promise.all(motions).then(() => undefined)
      pending.current.set(id, wait)
      return wait
    })
    if (reduced || !active.current.size) {
      for (const id of fresh) pending.current.delete(id)
      commit(fresh)
      return
    }
    void Promise.all(waits).then(() => {
      for (const id of fresh) pending.current.delete(id)
      commit(fresh)
    })
  }, [])
}
