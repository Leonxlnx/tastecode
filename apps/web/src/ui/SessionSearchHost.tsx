import {
  forwardRef,
  lazy,
  memo,
  Suspense,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react'
import type { SessionSearch as SessionSearchComponent } from './SessionSearch.js'

const SessionSearch = lazy(() =>
  import('./SessionSearch.js').then((module) => ({ default: module.SessionSearch })),
)

export type SessionSearchHandle = {
  open: (initialProjectPath?: string) => void
  close: () => void
}

type SessionSearchHostProps = Omit<
  ComponentProps<typeof SessionSearchComponent>,
  'initialProjectPath' | 'onClose'
>

const SessionSearchHostComponent = forwardRef<SessionSearchHandle, SessionSearchHostProps>(
  function SessionSearchHost(props, ref) {
    const [request, setRequest] = useState<{ initialProjectPath: string | undefined }>()
    const opened = useRef(false)
    const restoreTarget = useRef<HTMLElement | undefined>(undefined)
    const restorePending = useRef(false)
    const close = useCallback(() => {
      if (!opened.current) return
      opened.current = false
      restorePending.current = true
      setRequest(undefined)
    }, [])
    const open = useCallback((initialProjectPath?: string) => {
      if (!opened.current) {
        const active = document.activeElement
        restoreTarget.current =
          active instanceof HTMLElement && active !== document.body ? active : undefined
        opened.current = true
      }
      setRequest({ initialProjectPath })
    }, [])

    useLayoutEffect(() => {
      if (request || !restorePending.current) return
      restorePending.current = false
      const active = document.activeElement
      const focusIsUnclaimed =
        !active ||
        active === document.body ||
        active === document.documentElement ||
        !document.contains(active)
      const opener = restoreTarget.current
      restoreTarget.current = undefined
      if (!focusIsUnclaimed) return

      const target = canReceiveRestoredFocus(opener) ? opener : restoredFocusFallback()
      if (canReceiveRestoredFocus(target)) target.focus()
    }, [request])

    useImperativeHandle(ref, () => ({ open, close }), [close, open])

    if (!request) return null
    return (
      <Suspense fallback={null}>
        <SessionSearch
          {...props}
          initialProjectPath={request.initialProjectPath}
          onSelect={(threadId, turnId) => {
            close()
            props.onSelect(threadId, turnId)
          }}
          onClose={close}
        />
      </Suspense>
    )
  },
)

export const SessionSearchHost = memo(SessionSearchHostComponent)

const RESTORED_FOCUS_FALLBACKS = [
  '[aria-label="Search chats"]',
  '[aria-label="Search threads"]',
  'textarea[placeholder="Do anything"]',
  '.titlebar__toggle',
] as const

function restoredFocusFallback(): HTMLElement | undefined {
  for (const selector of RESTORED_FOCUS_FALLBACKS) {
    const target = document.querySelector<HTMLElement>(selector)
    if (canReceiveRestoredFocus(target)) return target
  }
  return undefined
}

function canReceiveRestoredFocus(target: HTMLElement | null | undefined): target is HTMLElement {
  return Boolean(
    target?.isConnected &&
    !target.matches(':disabled, [aria-disabled="true"]') &&
    !target.closest('[hidden], [inert], [aria-hidden="true"]'),
  )
}
