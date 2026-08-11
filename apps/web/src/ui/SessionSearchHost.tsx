import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react'
import { SessionSearch } from './SessionSearch.js'

export type SessionSearchHandle = {
  open: (initialProjectPath?: string) => void
  close: () => void
}

type SessionSearchHostProps = Omit<
  ComponentProps<typeof SessionSearch>,
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

      const fallback = document.querySelector<HTMLElement>('[aria-label="Search chats"]')
      const target = canReceiveRestoredFocus(opener) ? opener : fallback
      if (canReceiveRestoredFocus(target)) target.focus()
    }, [request])

    useImperativeHandle(ref, () => ({ open, close }), [close, open])

    if (!request) return null
    return (
      <SessionSearch
        {...props}
        initialProjectPath={request.initialProjectPath}
        onSelect={(threadId, turnId) => {
          close()
          props.onSelect(threadId, turnId)
        }}
        onClose={close}
      />
    )
  },
)

export const SessionSearchHost = memo(SessionSearchHostComponent)

function canReceiveRestoredFocus(target: HTMLElement | null | undefined): target is HTMLElement {
  return Boolean(
    target?.isConnected &&
    !target.matches(':disabled, [aria-disabled="true"]') &&
    !target.closest('[hidden], [inert], [aria-hidden="true"]'),
  )
}
