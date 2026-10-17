import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/**
 * Lets a disclosure re-measure its virtual row in the same commit that its
 * reveal enters or leaves flow. Waiting for the ResizeObserver would move the
 * rows below one frame after the reveal starts animating.
 */
export const RowMeasureContext = createContext<
  ((row: Element, header: Element | null) => void) | undefined
>(undefined)

type DisclosurePhase = 'closed' | 'opening' | 'open' | 'closing'

/** Mirror --dur-fast, --dur-press and --ease-out: the reveal transitions in thread.css. */
export const REVEAL_OPEN_MS = 180
export const REVEAL_CLOSE_MS = 140
export const REVEAL_EASING = 'cubic-bezier(0.23, 1, 0.32, 1)'

function settledPhase(phase: DisclosurePhase): DisclosurePhase {
  return phase === 'opening' ? 'open' : phase === 'closing' ? 'closed' : phase
}

export function useDisclosure() {
  const [phase, setPhase] = useState<DisclosurePhase>('closed')
  const revealRef = useRef<HTMLDivElement>(null)
  const measureRow = useContext(RowMeasureContext)
  const expanded = phase === 'open' || phase === 'opening'
  const transitioning = phase === 'opening' || phase === 'closing'

  // The reveal enters or leaves flow in this commit. Measuring the row now,
  // before paint, starts the rows below in the same frame as the wipe; the
  // ResizeObserver would only catch up a frame later.
  useLayoutEffect(() => {
    if (!transitioning || !measureRow) return
    const reveal = revealRef.current
    const row = reveal?.closest('.thread__row')
    // The summary button sits right before its reveal in every disclosure.
    if (row) measureRow(row, reveal?.previousElementSibling ?? null)
  }, [phase, transitioning, measureRow])

  useEffect(() => {
    if (!transitioning) return
    // A reversal before the first paint can leave no transition to finish.
    const timer = window.setTimeout(
      () => setPhase((current) => (current === phase ? settledPhase(phase) : current)),
      (phase === 'opening' ? REVEAL_OPEN_MS : REVEAL_CLOSE_MS) + 60,
    )
    return () => window.clearTimeout(timer)
  }, [phase, transitioning])

  const toggle = useCallback(() => {
    const reduceMotion =
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    setPhase((current) =>
      current === 'open' || current === 'opening'
        ? reduceMotion
          ? 'closed'
          : 'closing'
        : reduceMotion
          ? 'open'
          : 'opening',
    )
  }, [])

  const finishTransition = useCallback(() => {
    setPhase(settledPhase)
  }, [])

  return {
    expanded,
    contentMounted: phase !== 'closed',
    dataOpen: phase === 'open' ? 'true' : phase === 'closed' ? 'false' : phase,
    revealRef,
    toggle,
    finishTransition,
  } as const
}
