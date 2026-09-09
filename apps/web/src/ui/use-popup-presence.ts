import { useLayoutEffect, useState, type RefObject } from 'react'

/** Release interaction immediately, but keep the surface until its exit finishes. */
export function usePopupPresence(open: boolean, element: RefObject<HTMLElement | null>) {
  const [retained, setRetained] = useState(open)

  useLayoutEffect(() => {
    if (open) {
      setRetained(true)
      return
    }

    const animations = element.current?.getAnimations?.() ?? []
    if (animations.length === 0) {
      setRetained(false)
      return
    }

    let cancelled = false
    const finish = () => {
      if (!cancelled) setRetained(false)
    }
    // A hidden window can suspend animation completion. Never retain a closed popup.
    const timeout = window.setTimeout(finish, 250)
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [open, element])

  return open || retained
}
