import { createContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { inboxClockDelay } from './inbox-sidebar-time.js'

/**
 * Separate lanes keep a one-second working clock from re-rendering rows whose
 * labels only change per minute. A row reads the slowest lane that is accurate
 * for its label.
 */
export const InboxSecondNowContext = createContext(Date.now())
export const InboxMinuteNowContext = createContext(Date.now())

function useRetainedClockValue(now: number, bucket: number): number {
  const retained = useRef({ bucket, now })
  if (retained.current.bucket !== bucket) retained.current = { bucket, now }
  return retained.current.now
}

/** Sleeps until a visible label changes and stops entirely while the app is hidden. */
export function InboxClock(props: {
  hasRunningThread: boolean
  relativeTimes: readonly number[]
  wakeTimes: readonly number[]
  children: ReactNode
}) {
  const [now, setNow] = useState(Date.now)
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== 'hidden',
  )

  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = document.visibilityState !== 'hidden'
      setDocumentVisible(visible)
      if (visible) setNow(Date.now())
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])
  useEffect(() => {
    if (!documentVisible) return
    const delay = inboxClockDelay(props.hasRunningThread, props.relativeTimes, props.wakeTimes, now)
    if (delay === undefined) return
    const timer = window.setTimeout(() => setNow(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [documentVisible, now, props.hasRunningThread, props.relativeTimes, props.wakeTimes])

  const minuteNow = useRetainedClockValue(now, Math.floor(now / 60_000))

  return (
    <InboxSecondNowContext.Provider value={now}>
      <InboxMinuteNowContext.Provider value={minuteNow}>
        {props.children}
      </InboxMinuteNowContext.Provider>
    </InboxSecondNowContext.Provider>
  )
}

/** Keeps an array identity while its values are unchanged, so the clock effect stays asleep. */
export function useRetainedNumberArray(values: number[]): readonly number[] {
  const retained = useRef<readonly number[]>(values)
  if (
    retained.current.length !== values.length ||
    values.some((value, index) => retained.current[index] !== value)
  ) {
    retained.current = values
  }
  return retained.current
}
